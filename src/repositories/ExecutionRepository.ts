import { randomUUID } from 'node:crypto';
import type { DatabaseClient, DatabasePool } from '../db/pool.js';
import { isUniqueViolation, withTransaction } from '../db/pool.js';
import { AppError } from '../errors.js';
import type {
    ExecutionDetail,
    ExecutionListPage,
    ExecutionStatus,
    ExecutionSummary,
    ExecutionTrigger,
    Job,
    StepAttemptLog,
    StepLog,
    StepStatus
} from '../types/index.js';
import { coalesceOccurrences } from '../utils/cron.js';

interface ExecutionRow {
    id: string;
    job_id: string;
    job_definition: Job;
    trigger_type: ExecutionTrigger;
    status: ExecutionStatus;
    scheduled_for: Date | null;
    requested_at: Date;
    started_at: Date | null;
    finished_at: Date | null;
    cancel_requested_at: Date | null;
    duration_ms: string | number | null;
    error_code: string | null;
    error_message: string | null;
    skip_reason: string | null;
}

interface StepRow {
    step_id: string;
    step_name: string;
    step_type: string;
    status: StepStatus;
    started_at: Date | null;
    finished_at: Date | null;
    duration_ms: string | number | null;
    output: unknown;
    error_code: string | null;
    error_message: string | null;
    reason: string | null;
}

interface AttemptRow {
    step_id: string;
    attempt: number;
    status: StepAttemptLog['status'];
    started_at: Date;
    finished_at: Date | null;
    duration_ms: string | number | null;
    error_code: string | null;
    error_message: string | null;
}

export interface ClaimedExecution {
    executionId: string;
    jobId: string;
    jobDefinition: Job;
    requestedAt: Date;
    startedAt: Date;
}

export interface ExecutionFilters {
    jobId?: string;
    status?: ExecutionStatus;
    limit: number;
    cursor?: string;
}

export class ExecutionRepository {
    constructor(readonly pool: DatabasePool) {}

    async enqueueManual(jobId: string): Promise<ExecutionSummary> {
        try {
            const executionId = await withTransaction(this.pool, async client => {
                const result = await client.query<{ definition: Job }>(
                    'SELECT definition FROM jobs WHERE id = $1 FOR UPDATE',
                    [jobId]
                );
                const job = result.rows[0]?.definition;
                if (job === undefined) throw new AppError('JOB_NOT_FOUND', `Job with id ${jobId} not found.`, 404);
                return insertExecution(client, job, 'manual', null, 'queued');
            });
            return (await this.getSummary(executionId))!;
        } catch (error: unknown) {
            if (isUniqueViolation(error, 'executions_one_active_per_job_uidx')) {
                throw new AppError('JOB_ALREADY_ACTIVE', `Job with id ${jobId} already has a queued or running execution.`, 409);
            }
            throw error;
        }
    }

    async processDueJobs(now = new Date(), limit = 100): Promise<number> {
        return withTransaction(this.pool, async client => {
            const due = await client.query<{ id: string; definition: Job; schedule: string; timezone: string }>(
                `SELECT id, definition, schedule, timezone
                 FROM jobs
                 WHERE status = 'active' AND schedule IS NOT NULL AND next_run_at <= $1
                 ORDER BY next_run_at, id
                 FOR UPDATE SKIP LOCKED
                 LIMIT $2`,
                [now, limit]
            );
            for (const row of due.rows) {
                const occurrence = coalesceOccurrences(row.schedule, row.timezone, now);
                const active = await client.query(
                    `SELECT 1 FROM executions WHERE job_id = $1 AND status IN ('queued', 'running') LIMIT 1`,
                    [row.id]
                );
                const status: ExecutionStatus = (active.rowCount ?? 0) > 0 ? 'skipped' : 'queued';
                await insertExecution(client, row.definition, 'scheduled', occurrence.scheduledFor, status, status === 'skipped' ? 'overlap' : null);
                await client.query(
                    'UPDATE jobs SET next_run_at = $2, updated_at = clock_timestamp() WHERE id = $1',
                    [row.id, occurrence.nextRunAt]
                );
            }
            return due.rows.length;
        });
    }

    async claimOldestQueued(): Promise<ClaimedExecution | undefined> {
        return withTransaction(this.pool, async client => {
            const claimed = await client.query<ExecutionRow>(
                `WITH candidate AS (
                    SELECT id FROM executions
                    WHERE status = 'queued'
                    ORDER BY requested_at, id
                    FOR UPDATE SKIP LOCKED
                    LIMIT 1
                 )
                 UPDATE executions e
                 SET status = 'running', started_at = clock_timestamp(), updated_at = clock_timestamp()
                 FROM candidate
                 WHERE e.id = candidate.id
                 RETURNING e.*`
            );
            const row = claimed.rows[0];
            if (row === undefined || row.started_at === null) return undefined;
            await client.query(
                'UPDATE jobs SET last_run_at = $2, updated_at = clock_timestamp() WHERE id = $1',
                [row.job_id, row.started_at]
            );
            return {
                executionId: row.id,
                jobId: row.job_id,
                jobDefinition: row.job_definition,
                requestedAt: row.requested_at,
                startedAt: row.started_at
            };
        });
    }

    async getSummary(executionId: string): Promise<ExecutionSummary | undefined> {
        const result = await this.pool.query<ExecutionRow>('SELECT * FROM executions WHERE id = $1', [executionId]);
        return result.rows[0] === undefined ? undefined : mapSummary(result.rows[0]);
    }

    async getDetail(executionId: string): Promise<ExecutionDetail | undefined> {
        const execution = await this.pool.query<ExecutionRow>('SELECT * FROM executions WHERE id = $1', [executionId]);
        const row = execution.rows[0];
        if (row === undefined) return undefined;
        const [steps, attempts] = await Promise.all([
            this.pool.query<StepRow>('SELECT * FROM execution_steps WHERE execution_id = $1 ORDER BY step_order', [executionId]),
            this.pool.query<AttemptRow>('SELECT * FROM execution_attempts WHERE execution_id = $1 ORDER BY step_id, attempt', [executionId])
        ]);
        const attemptsByStep = new Map<string, StepAttemptLog[]>();
        for (const attempt of attempts.rows) {
            const list = attemptsByStep.get(attempt.step_id) ?? [];
            list.push(mapAttempt(attempt));
            attemptsByStep.set(attempt.step_id, list);
        }
        const stepResults: Record<string, StepLog> = {};
        for (const step of steps.rows) stepResults[step.step_id] = mapStep(step, attemptsByStep.get(step.step_id) ?? []);
        return { ...mapSummary(row), jobDefinition: row.job_definition, stepResults };
    }

    async list(filters: ExecutionFilters): Promise<ExecutionListPage> {
        const parameters: unknown[] = [];
        const predicates: string[] = [];
        if (filters.jobId !== undefined) {
            parameters.push(filters.jobId);
            predicates.push(`job_id = $${parameters.length}`);
        }
        if (filters.status !== undefined) {
            parameters.push(filters.status);
            predicates.push(`status = $${parameters.length}`);
        }
        if (filters.cursor !== undefined) {
            const cursor = decodeCursor(filters.cursor);
            parameters.push(cursor.requestedAt, cursor.executionId);
            predicates.push(`(requested_at, id) < ($${parameters.length - 1}::timestamptz, $${parameters.length}::uuid)`);
        }
        parameters.push(filters.limit + 1);
        const where = predicates.length === 0 ? '' : `WHERE ${predicates.join(' AND ')}`;
        const result = await this.pool.query<ExecutionRow>(
            `SELECT * FROM executions ${where} ORDER BY requested_at DESC, id DESC LIMIT $${parameters.length}`,
            parameters
        );
        const hasMore = result.rows.length > filters.limit;
        const rows = hasMore ? result.rows.slice(0, filters.limit) : result.rows;
        const last = rows.at(-1);
        return {
            items: rows.map(mapSummary),
            nextCursor: hasMore && last !== undefined ? encodeCursor(last.requested_at, last.id) : null
        };
    }

    async requestCancellation(executionId: string): Promise<{ summary: ExecutionSummary; shouldAbort: boolean }> {
        const shouldAbort = await withTransaction(this.pool, async client => {
            const result = await client.query<ExecutionRow>('SELECT * FROM executions WHERE id = $1 FOR UPDATE', [executionId]);
            const execution = result.rows[0];
            if (execution === undefined) throw new AppError('EXECUTION_NOT_FOUND', `Execution ${executionId} not found.`, 404);
            if (execution.status === 'cancelled') return false;
            if (execution.status === 'queued') {
                await client.query(
                    `UPDATE executions SET status = 'cancelled', cancel_requested_at = clock_timestamp(),
                        finished_at = clock_timestamp(), updated_at = clock_timestamp()
                     WHERE id = $1`,
                    [executionId]
                );
                await client.query(
                    `UPDATE execution_steps SET status = 'cancelled', finished_at = clock_timestamp(), reason = 'Execution cancelled before it started.'
                     WHERE execution_id = $1 AND status = 'pending'`,
                    [executionId]
                );
                return false;
            }
            if (execution.status === 'running') {
                await client.query(
                    `UPDATE executions SET cancel_requested_at = COALESCE(cancel_requested_at, clock_timestamp()), updated_at = clock_timestamp()
                     WHERE id = $1`,
                    [executionId]
                );
                return true;
            }
            throw new AppError('EXECUTION_NOT_CANCELLABLE', `Execution ${executionId} is already ${execution.status}.`, 409);
        });
        return { summary: (await this.getSummary(executionId))!, shouldAbort };
    }

    async isCancellationRequested(executionId: string): Promise<boolean> {
        const result = await this.pool.query<{ requested: boolean }>(
            'SELECT cancel_requested_at IS NOT NULL AS requested FROM executions WHERE id = $1',
            [executionId]
        );
        return result.rows[0]?.requested ?? false;
    }

    async finishExecution(
        executionId: string,
        status: 'success' | 'failed' | 'cancelled',
        errorCode: string | null,
        errorMessage: string | null
    ): Promise<void> {
        await this.pool.query(
            `UPDATE executions
             SET status = $2, finished_at = clock_timestamp(),
                 duration_ms = GREATEST(0, floor(extract(epoch FROM (clock_timestamp() - started_at)) * 1000))::bigint,
                 error_code = $3, error_message = $4, updated_at = clock_timestamp()
             WHERE id = $1 AND status = 'running'`,
            [executionId, status, errorCode, errorMessage]
        );
    }

    async stepStarted(executionId: string, stepId: string, startedAt: Date): Promise<void> {
        await this.pool.query(
            `UPDATE execution_steps SET status = 'running', started_at = $3
             WHERE execution_id = $1 AND step_id = $2 AND status = 'pending'`,
            [executionId, stepId, startedAt]
        );
    }

    async attemptStarted(executionId: string, stepId: string, attempt: number, startedAt: Date): Promise<void> {
        await this.pool.query(
            `INSERT INTO execution_attempts(execution_id, step_id, attempt, status, started_at)
             VALUES ($1, $2, $3, 'running', $4)`,
            [executionId, stepId, attempt, startedAt]
        );
    }

    async attemptFinished(executionId: string, stepId: string, attempt: StepAttemptLog): Promise<void> {
        await this.pool.query(
            `UPDATE execution_attempts SET status = $4, finished_at = $5,
                duration_ms = $6, error_code = $7, error_message = $8
             WHERE execution_id = $1 AND step_id = $2 AND attempt = $3`,
            [executionId, stepId, attempt.attempt, attempt.status, attempt.finishedAt ?? null,
                attempt.durationMs ?? null, attempt.errorCode ?? null, attempt.error ?? null]
        );
    }

    async stepFinished(executionId: string, step: StepLog): Promise<void> {
        const serializedOutput = step.output === undefined || step.output === null
            ? null
            : JSON.stringify(step.output);
        await this.pool.query(
            `UPDATE execution_steps SET status = $3, finished_at = $4, duration_ms = $5,
                output = $6, error_code = $7, error_message = $8, reason = $9
             WHERE execution_id = $1 AND step_id = $2`,
            [executionId, step.stepId, step.status, step.finishedAt ?? null, step.durationMs ?? null,
                serializedOutput, step.errorCode ?? null, step.error ?? null, step.reason ?? null]
        );
    }

    async cancelUnfinishedSteps(executionId: string, reason: string): Promise<void> {
        await this.pool.query(
            `UPDATE execution_steps SET status = 'cancelled', finished_at = clock_timestamp(), reason = $2,
                duration_ms = CASE WHEN started_at IS NULL THEN NULL ELSE GREATEST(0, floor(extract(epoch FROM (clock_timestamp() - started_at)) * 1000))::bigint END
             WHERE execution_id = $1 AND status IN ('pending', 'running')`,
            [executionId, reason]
        );
        await this.pool.query(
            `UPDATE execution_attempts SET status = 'cancelled', finished_at = clock_timestamp(),
                duration_ms = GREATEST(0, floor(extract(epoch FROM (clock_timestamp() - started_at)) * 1000))::bigint,
                error_code = 'EXECUTION_CANCELLED', error_message = $2
             WHERE execution_id = $1 AND status = 'running'`,
            [executionId, reason]
        );
    }

    async reconcileInterrupted(): Promise<number> {
        return withTransaction(this.pool, async client => {
            const running = await client.query<{ id: string }>(
                `UPDATE executions SET status = 'failed', finished_at = clock_timestamp(),
                    duration_ms = GREATEST(0, floor(extract(epoch FROM (clock_timestamp() - started_at)) * 1000))::bigint,
                    error_code = 'SERVER_INTERRUPTED', error_message = 'Server stopped before execution completed.',
                    updated_at = clock_timestamp()
                 WHERE status = 'running' RETURNING id`
            );
            if (running.rows.length === 0) return 0;
            const ids = running.rows.map(row => row.id);
            await client.query(
                `UPDATE execution_steps SET status = 'failed', finished_at = clock_timestamp(),
                    error_code = 'SERVER_INTERRUPTED', error_message = 'Server stopped during this step.'
                 WHERE execution_id = ANY($1::uuid[]) AND status = 'running'`,
                [ids]
            );
            await client.query(
                `UPDATE execution_steps SET status = 'cancelled', finished_at = clock_timestamp(),
                    reason = 'Server stopped before this step started.'
                 WHERE execution_id = ANY($1::uuid[]) AND status = 'pending'`,
                [ids]
            );
            await client.query(
                `UPDATE execution_attempts SET status = 'failed', finished_at = clock_timestamp(),
                    error_code = 'SERVER_INTERRUPTED', error_message = 'Server stopped during this attempt.'
                 WHERE execution_id = ANY($1::uuid[]) AND status = 'running'`,
                [ids]
            );
            return ids.length;
        });
    }
}

async function insertExecution(
    client: DatabaseClient,
    job: Job,
    trigger: ExecutionTrigger,
    scheduledFor: Date | null,
    status: ExecutionStatus,
    skipReason: string | null = null
): Promise<string> {
    const executionId = randomUUID();
    const terminal = status === 'skipped';
    await client.query(
        `INSERT INTO executions(id, job_id, job_definition, trigger_type, status, scheduled_for, finished_at, skip_reason)
         VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $7 THEN clock_timestamp() ELSE NULL END, $8)`,
        [executionId, job.id, job, trigger, status, scheduledFor, terminal, skipReason]
    );
    for (const step of [...job.STEPS].sort((a, b) => a.ORDER - b.ORDER)) {
        await client.query(
            `INSERT INTO execution_steps(execution_id, step_id, step_name, step_type, step_order, status, finished_at, reason)
             VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $6 = 'skipped' THEN clock_timestamp() ELSE NULL END, $7)`,
            [executionId, step.ID, step.NAME, step.TYPE, step.ORDER, terminal ? 'skipped' : 'pending', skipReason]
        );
    }
    return executionId;
}

function mapSummary(row: ExecutionRow): ExecutionSummary {
    return {
        executionId: row.id,
        logId: row.id,
        jobId: row.job_id,
        trigger: row.trigger_type,
        status: row.status,
        scheduledFor: row.scheduled_for?.toISOString() ?? null,
        requestedAt: row.requested_at.toISOString(),
        startedAt: row.started_at?.toISOString() ?? null,
        finishedAt: row.finished_at?.toISOString() ?? null,
        cancelRequestedAt: row.cancel_requested_at?.toISOString() ?? null,
        durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
        error: row.error_message === null ? null : { code: row.error_code, message: row.error_message },
        skipReason: row.skip_reason
    };
}

function mapAttempt(row: AttemptRow): StepAttemptLog {
    return compact({
        attempt: row.attempt,
        status: row.status,
        startedAt: row.started_at.toISOString(),
        finishedAt: row.finished_at?.toISOString(),
        durationMs: row.duration_ms === null ? undefined : Number(row.duration_ms),
        errorCode: row.error_code ?? undefined,
        error: row.error_message ?? undefined
    }) as StepAttemptLog;
}

function mapStep(row: StepRow, attempts: StepAttemptLog[]): StepLog {
    return compact({
        stepId: row.step_id,
        stepName: row.step_name,
        stepType: row.step_type,
        status: row.status,
        startedAt: row.started_at?.toISOString(),
        finishedAt: row.finished_at?.toISOString(),
        durationMs: row.duration_ms === null ? undefined : Number(row.duration_ms),
        attempts,
        output: row.output ?? undefined,
        errorCode: row.error_code ?? undefined,
        error: row.error_message ?? undefined,
        reason: row.reason ?? undefined
    }) as StepLog;
}

function compact<T extends Record<string, unknown>>(value: T): Partial<T> {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>;
}

function encodeCursor(requestedAt: Date, executionId: string): string {
    return Buffer.from(JSON.stringify({ requestedAt: requestedAt.toISOString(), executionId }), 'utf8').toString('base64url');
}

function decodeCursor(value: string): { requestedAt: string; executionId: string } {
    try {
        const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, unknown>;
        if (typeof parsed.requestedAt !== 'string' || Number.isNaN(Date.parse(parsed.requestedAt)) ||
            typeof parsed.executionId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(parsed.executionId)) {
            throw new Error('Invalid cursor fields.');
        }
        return { requestedAt: parsed.requestedAt, executionId: parsed.executionId };
    } catch {
        throw new AppError('INVALID_CURSOR', 'cursor is invalid.', 400);
    }
}
