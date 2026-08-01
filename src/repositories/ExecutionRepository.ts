import { randomUUID } from 'node:crypto';
import type { DatabaseClient, DatabasePool } from '../db/pool.js';
import { isUniqueViolation, withTransaction } from '../db/pool.js';
import { AppError } from '../errors.js';
import { recordExecutionFailureAttention } from './AttentionRepository.js';
import type {
    ActorSummary,
    AuthenticatedActor,
    ExecutionDetail,
    ExecutionEvent,
    ExecutionListPage,
    ExecutionStatus,
    ExecutionSummary,
    ExecutionTrigger,
    Job,
    PageResponse,
    StepAttemptLog,
    StepLog,
    StepStatus,
    WebhookDeliverySummary,
    WebhookEventStatus
} from '../types/index.js';
import { coalesceOccurrences } from '../utils/cron.js';

interface ExecutionRow {
    id: string;
    job_id: string;
    job_definition: Job;
    input: Record<string, unknown>;
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
    requested_by_type: ActorSummary['type'];
    requested_by_user_id: string | null;
    requested_by_label: string;
    cancel_requested_by_type: 'user' | 'api_token' | null;
    cancel_requested_by_user_id: string | null;
    cancel_requested_by_label: string | null;
}

interface EventRow { id: string; execution_id: string; event_type: string; payload: Record<string, unknown>; created_at: Date; }

interface WebhookDeliveryRow {
    id: string;
    execution_id: string;
    event_type: string;
    url: string;
    status: WebhookDeliverySummary['status'];
    attempt_count: number;
    next_attempt_at: Date;
    response_status: number | null;
    last_error: string | null;
    created_at: Date;
    updated_at: Date;
    delivered_at: Date | null;
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
    item_index: number;
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
    input: Record<string, unknown>;
}

export interface ExecutionFilters {
    jobId?: string;
    status?: ExecutionStatus;
    trigger?: ExecutionTrigger;
    from?: Date;
    to?: Date;
    limit: number;
    cursor?: string;
    page?: number;
    order?: 'asc' | 'desc';
}

export class ExecutionRepository {
    constructor(readonly pool: DatabasePool) {}

    async enqueueManual(
        jobId: string,
        input: Record<string, unknown> = {},
        actor?: AuthenticatedActor
    ): Promise<ExecutionSummary> {
        try {
            const executionId = await withTransaction(this.pool, async client => {
                const result = await client.query<{ definition: Job }>(
                    'SELECT definition FROM jobs WHERE id = $1 FOR UPDATE',
                    [jobId]
                );
                const job = result.rows[0]?.definition;
                if (job === undefined) throw new AppError('JOB_NOT_FOUND', `Job with id ${jobId} not found.`, 404);
                return insertExecution(client, job, input, 'manual', null, 'queued', null, actor);
            });
            return (await this.getSummary(executionId))!;
        } catch (error: unknown) {
            if (isUniqueViolation(error, 'executions_one_active_per_job_uidx')) {
                throw new AppError('JOB_ALREADY_ACTIVE', `Job with id ${jobId} already has a queued or running execution.`, 409);
            }
            throw error;
        }
    }

    async enqueueManualWithClient(
        client: DatabaseClient,
        job: Job,
        input: Record<string, unknown>,
        actor: AuthenticatedActor
    ): Promise<string> {
        return insertExecution(client, job, input, 'manual', null, 'queued', null, actor);
    }

    async processDueJobs(now?: Date, limit = 100): Promise<number> {
        return withTransaction(this.pool, async client => {
            const effectiveNow = now ?? (await client.query<{ now: Date }>(
                'SELECT clock_timestamp() AS now'
            )).rows[0]!.now;
            const due = await client.query<{ id: string; definition: Job; schedule: string; timezone: string }>(
                `SELECT id, definition, schedule, timezone
                 FROM jobs
                 WHERE status = 'active' AND schedule IS NOT NULL AND next_run_at <= $1
                 ORDER BY next_run_at, id
                 FOR UPDATE SKIP LOCKED
                 LIMIT $2`,
                [effectiveNow, limit]
            );
            for (const row of due.rows) {
                const occurrence = coalesceOccurrences(row.schedule, row.timezone, effectiveNow);
                const active = await client.query(
                    `SELECT 1 FROM executions WHERE job_id = $1 AND status IN ('queued', 'running') LIMIT 1`,
                    [row.id]
                );
                const status: ExecutionStatus = (active.rowCount ?? 0) > 0 ? 'skipped' : 'queued';
                await insertExecution(client, row.definition, {}, 'scheduled', occurrence.scheduledFor, status, status === 'skipped' ? 'overlap' : null);
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
            await appendEvent(client, row.id, 'execution.running', {
                jobId: row.job_id, startedAt: row.started_at.toISOString()
            });
            return {
                executionId: row.id,
                jobId: row.job_id,
                jobDefinition: row.job_definition,
                requestedAt: row.requested_at,
                startedAt: row.started_at,
                input: row.input
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
            this.pool.query<AttemptRow>('SELECT * FROM execution_attempts WHERE execution_id = $1 ORDER BY step_id, item_index, attempt', [executionId])
        ]);
        const attemptsByStep = new Map<string, StepAttemptLog[]>();
        for (const attempt of attempts.rows) {
            const list = attemptsByStep.get(attempt.step_id) ?? [];
            list.push(mapAttempt(attempt));
            attemptsByStep.set(attempt.step_id, list);
        }
        const stepResults: Record<string, StepLog> = {};
        for (const step of steps.rows) stepResults[step.step_id] = mapStep(step, attemptsByStep.get(step.step_id) ?? []);
        return { ...mapSummary(row), input: row.input, jobDefinition: row.job_definition, stepResults };
    }

    async list(filters: ExecutionFilters & { page: number }): Promise<PageResponse<ExecutionSummary>>;
    async list(filters: ExecutionFilters): Promise<ExecutionListPage>;
    async list(filters: ExecutionFilters): Promise<ExecutionListPage | PageResponse<ExecutionSummary>> {
        const order = filters.order ?? 'desc';
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
        if (filters.trigger !== undefined) {
            parameters.push(filters.trigger);
            predicates.push(`trigger_type = $${parameters.length}`);
        }
        if (filters.from !== undefined) {
            parameters.push(filters.from);
            predicates.push(`requested_at >= $${parameters.length}`);
        }
        if (filters.to !== undefined) {
            parameters.push(filters.to);
            predicates.push(`requested_at < $${parameters.length}`);
        }
        if (filters.cursor !== undefined) {
            const cursor = decodeCursor(filters.cursor);
            parameters.push(cursor.requestedAt, cursor.executionId);
            predicates.push(`(requested_at, id) ${order === 'asc' ? '>' : '<'} ($${parameters.length - 1}::timestamptz, $${parameters.length}::uuid)`);
        }
        const where = predicates.length === 0 ? '' : `WHERE ${predicates.join(' AND ')}`;
        if (filters.page !== undefined) {
            const count = await this.pool.query<{ count: string }>(
                `SELECT count(*)::text AS count FROM executions ${where}`,
                parameters
            );
            const total = Number(count.rows[0]?.count ?? 0);
            const pageParameters = [...parameters, filters.limit, (filters.page - 1) * filters.limit];
            const result = await this.pool.query<ExecutionRow>(
                `SELECT * FROM executions ${where}
                 ORDER BY requested_at ${order.toUpperCase()}, id ${order.toUpperCase()}
                 LIMIT $${pageParameters.length - 1} OFFSET $${pageParameters.length}`,
                pageParameters
            );
            return {
                items: result.rows.map(mapSummary),
                page: filters.page,
                pageSize: filters.limit,
                total,
                totalPages: Math.ceil(total / filters.limit)
            };
        }
        parameters.push(filters.limit + 1);
        const result = await this.pool.query<ExecutionRow>(
            `SELECT * FROM executions ${where} ORDER BY requested_at ${order.toUpperCase()}, id ${order.toUpperCase()} LIMIT $${parameters.length}`,
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

    async listEvents(executionId: string, afterId = 0n, limit = 200): Promise<ExecutionEvent[]> {
        const result = await this.pool.query<EventRow>(
            `SELECT id, execution_id, event_type, payload, created_at
             FROM execution_events WHERE execution_id = $1 AND id > $2
             ORDER BY id LIMIT $3`,
            [executionId, afterId.toString(), limit]
        );
        return result.rows.map(row => ({
            eventId: String(row.id), executionId: row.execution_id, type: row.event_type,
            payload: row.payload, createdAt: row.created_at.toISOString()
        }));
    }

    async latestEventId(): Promise<bigint> {
        const result = await this.pool.query<{ id: string | null }>(
            'SELECT max(id)::text AS id FROM execution_events'
        );
        return BigInt(result.rows[0]?.id ?? '0');
    }

    async listEventsAfter(afterId = 0n, limit = 200): Promise<ExecutionEvent[]> {
        const result = await this.pool.query<EventRow>(
            `SELECT id, execution_id, event_type, payload, created_at
             FROM execution_events WHERE id > $1
             ORDER BY id LIMIT $2`,
            [afterId.toString(), limit]
        );
        return result.rows.map(row => ({
            eventId: String(row.id),
            executionId: row.execution_id,
            type: row.event_type,
            payload: row.payload,
            createdAt: row.created_at.toISOString()
        }));
    }

    async listWebhookDeliveries(executionId: string): Promise<WebhookDeliverySummary[]> {
        const result = await this.pool.query<WebhookDeliveryRow>(
            `SELECT id, execution_id, event_type, url, status, attempt_count, next_attempt_at,
                    response_status, last_error, created_at, updated_at, delivered_at
             FROM webhook_deliveries WHERE execution_id = $1 ORDER BY created_at, id`,
            [executionId]
        );
        return result.rows.map(row => ({
            deliveryId: row.id,
            executionId: row.execution_id,
            eventType: row.event_type,
            url: row.url,
            status: row.status,
            attemptCount: row.attempt_count,
            nextAttemptAt: row.next_attempt_at.toISOString(),
            responseStatus: row.response_status,
            lastError: row.last_error,
            createdAt: row.created_at.toISOString(),
            updatedAt: row.updated_at.toISOString(),
            deliveredAt: row.delivered_at?.toISOString() ?? null
        }));
    }

    async countTerminalBefore(cutoff: Date): Promise<number> {
        const result = await this.pool.query<{ count: string }>(
            `SELECT count(*)::text AS count FROM executions
             WHERE status IN ('success', 'failed', 'cancelled', 'skipped') AND finished_at < $1`,
            [cutoff]
        );
        return Number(result.rows[0]?.count ?? 0);
    }

    async deleteTerminalBefore(cutoff: Date, limit: number, dryRun: boolean): Promise<string[]> {
        return withTransaction(this.pool, async client => {
            const candidates = await client.query<{ id: string }>(
                `SELECT id FROM executions
                 WHERE status IN ('success', 'failed', 'cancelled', 'skipped') AND finished_at < $1
                 ORDER BY finished_at, id FOR UPDATE SKIP LOCKED LIMIT $2`,
                [cutoff, limit]
            );
            const ids = candidates.rows.map(row => row.id);
            if (!dryRun && ids.length > 0) await client.query('DELETE FROM executions WHERE id = ANY($1::uuid[])', [ids]);
            return ids;
        });
    }

    async requestCancellation(
        executionId: string,
        actor?: AuthenticatedActor
    ): Promise<{ summary: ExecutionSummary; shouldAbort: boolean }> {
        const actorType = actor === undefined ? null : actor.authType === 'session' ? 'user' : 'api_token';
        const shouldAbort = await withTransaction(this.pool, async client => {
            const result = await client.query<ExecutionRow>('SELECT * FROM executions WHERE id = $1 FOR UPDATE', [executionId]);
            const execution = result.rows[0];
            if (execution === undefined) throw new AppError('EXECUTION_NOT_FOUND', `Execution ${executionId} not found.`, 404);
            if (execution.status === 'cancelled') return false;
            if (execution.status === 'queued') {
                const cancelled = await client.query<ExecutionRow>(
                    `UPDATE executions SET status = 'cancelled', cancel_requested_at = clock_timestamp(),
                        cancel_requested_by_type = $2, cancel_requested_by_user_id = $3,
                        cancel_requested_by_label = $4,
                        finished_at = clock_timestamp(), updated_at = clock_timestamp()
                     WHERE id = $1 RETURNING *`,
                    [executionId, actorType, actor?.userId ?? null, actor?.email ?? null]
                );
                await client.query(
                    `UPDATE execution_steps SET status = 'cancelled', finished_at = clock_timestamp(), reason = 'Execution cancelled before it started.'
                     WHERE execution_id = $1 AND status = 'pending'`,
                    [executionId]
                );
                await appendEvent(client, executionId, 'execution.cancel_requested', {
                    status: 'queued', requestedBy: actor?.email ?? 'system'
                });
                await appendEvent(client, executionId, 'execution.cancelled', { reason: 'Execution cancelled before it started.' });
                await enqueueTerminalWebhooks(client, cancelled.rows[0]!);
                return false;
            }
            if (execution.status === 'running') {
                await client.query(
                    `UPDATE executions SET cancel_requested_at = COALESCE(cancel_requested_at, clock_timestamp()),
                        cancel_requested_by_type = COALESCE(cancel_requested_by_type, $2),
                        cancel_requested_by_user_id = COALESCE(cancel_requested_by_user_id, $3),
                        cancel_requested_by_label = COALESCE(cancel_requested_by_label, $4),
                        updated_at = clock_timestamp()
                     WHERE id = $1`,
                    [executionId, actorType, actor?.userId ?? null, actor?.email ?? null]
                );
                if (execution.cancel_requested_at === null) {
                    await appendEvent(client, executionId, 'execution.cancel_requested', {
                        status: 'running', requestedBy: actor?.email ?? 'system'
                    });
                }
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
        await withTransaction(this.pool, async client => {
            const result = await client.query<ExecutionRow>(
                `UPDATE executions
                 SET status = $2, finished_at = clock_timestamp(),
                     duration_ms = GREATEST(0, floor(extract(epoch FROM (clock_timestamp() - started_at)) * 1000))::bigint,
                     error_code = $3, error_message = $4, updated_at = clock_timestamp()
                 WHERE id = $1 AND status = 'running' RETURNING *`,
                [executionId, status, errorCode, errorMessage]
            );
            const row = result.rows[0];
            if (row === undefined) return;
            await appendEvent(client, executionId, `execution.${status}`, {
                status, finishedAt: row.finished_at?.toISOString() ?? null,
                durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
                ...(errorCode === null ? {} : { errorCode }), ...(errorMessage === null ? {} : { error: errorMessage })
            });
            if (status === 'failed') {
                await recordExecutionFailureAttention(client, {
                    executionId: row.id,
                    jobId: row.job_id,
                    reason: row.error_message ?? 'Execution failed without an error message.',
                    occurredAt: row.finished_at ?? row.requested_at,
                    detailSnapshot: {
                        errorCode: row.error_code,
                        error: row.error_message,
                        trigger: row.trigger_type,
                        input: row.input
                    }
                });
            }
            await enqueueTerminalWebhooks(client, row);
        });
    }

    async stepStarted(executionId: string, stepId: string, startedAt: Date): Promise<void> {
        await withTransaction(this.pool, async client => {
            await client.query(
                `UPDATE execution_steps SET status = 'running', started_at = $3
                 WHERE execution_id = $1 AND step_id = $2 AND status = 'pending'`,
                [executionId, stepId, startedAt]
            );
            await appendEvent(client, executionId, 'step.running', { stepId, startedAt: startedAt.toISOString() });
        });
    }

    async attemptStarted(executionId: string, stepId: string, attempt: number, startedAt: Date, itemIndex?: number): Promise<void> {
        await withTransaction(this.pool, async client => {
            await client.query(
                `INSERT INTO execution_attempts(execution_id, step_id, item_index, attempt, status, started_at)
                 VALUES ($1, $2, $3, $4, 'running', $5)`,
                [executionId, stepId, itemIndex ?? -1, attempt, startedAt]
            );
            await appendEvent(client, executionId, 'attempt.running', {
                stepId, attempt, ...(itemIndex === undefined ? {} : { itemIndex }), startedAt: startedAt.toISOString()
            });
        });
    }

    async attemptFinished(executionId: string, stepId: string, attempt: StepAttemptLog): Promise<void> {
        await withTransaction(this.pool, async client => {
            await client.query(
                `UPDATE execution_attempts SET status = $5, finished_at = $6,
                    duration_ms = $7, error_code = $8, error_message = $9
                 WHERE execution_id = $1 AND step_id = $2 AND attempt = $3 AND item_index = $4`,
                [executionId, stepId, attempt.attempt, attempt.itemIndex ?? -1, attempt.status, attempt.finishedAt ?? null,
                    attempt.durationMs ?? null, attempt.errorCode ?? null, attempt.error ?? null]
            );
            await appendEvent(client, executionId, `attempt.${attempt.status}`, {
                stepId, attempt: attempt.attempt, status: attempt.status,
                ...(attempt.itemIndex === undefined ? {} : { itemIndex: attempt.itemIndex }),
                finishedAt: attempt.finishedAt ?? null, durationMs: attempt.durationMs ?? null,
                ...(attempt.errorCode === undefined ? {} : { errorCode: attempt.errorCode }),
                ...(attempt.error === undefined ? {} : { error: attempt.error })
            });
        });
    }

    async stepFinished(executionId: string, step: StepLog): Promise<void> {
        const serializedOutput = step.output === undefined || step.output === null
            ? null
            : JSON.stringify(step.output);
        await withTransaction(this.pool, async client => {
            await client.query(
                `UPDATE execution_steps SET status = $3, finished_at = $4, duration_ms = $5,
                    output = $6, error_code = $7, error_message = $8, reason = $9
                 WHERE execution_id = $1 AND step_id = $2`,
                [executionId, step.stepId, step.status, step.finishedAt ?? null, step.durationMs ?? null,
                    serializedOutput, step.errorCode ?? null, step.error ?? null, step.reason ?? null]
            );
            await appendEvent(client, executionId, `step.${step.status}`, {
                stepId: step.stepId, stepName: step.stepName, status: step.status,
                finishedAt: step.finishedAt ?? null, durationMs: step.durationMs ?? null,
                ...(step.output === undefined ? {} : { output: step.output }),
                ...(step.errorCode === undefined ? {} : { errorCode: step.errorCode }),
                ...(step.error === undefined ? {} : { error: step.error }),
                ...(step.reason === undefined ? {} : { reason: step.reason })
            });
        });
    }

    async cancelUnfinishedSteps(executionId: string, reason: string): Promise<void> {
        await withTransaction(this.pool, async client => {
            const steps = await client.query<{ step_id: string }>(
                `UPDATE execution_steps SET status = 'cancelled', finished_at = clock_timestamp(), reason = $2,
                    duration_ms = CASE WHEN started_at IS NULL THEN NULL ELSE GREATEST(0, floor(extract(epoch FROM (clock_timestamp() - started_at)) * 1000))::bigint END
                 WHERE execution_id = $1 AND status IN ('pending', 'running') RETURNING step_id`,
                [executionId, reason]
            );
            const attempts = await client.query<{ step_id: string; attempt: number; item_index: number }>(
                `UPDATE execution_attempts SET status = 'cancelled', finished_at = clock_timestamp(),
                    duration_ms = GREATEST(0, floor(extract(epoch FROM (clock_timestamp() - started_at)) * 1000))::bigint,
                    error_code = 'EXECUTION_CANCELLED', error_message = $2
                 WHERE execution_id = $1 AND status = 'running' RETURNING step_id, attempt, item_index`,
                [executionId, reason]
            );
            for (const attempt of attempts.rows) {
                await appendEvent(client, executionId, 'attempt.cancelled', {
                    stepId: attempt.step_id, attempt: attempt.attempt,
                    ...(attempt.item_index < 0 ? {} : { itemIndex: attempt.item_index }), reason
                });
            }
            for (const step of steps.rows) {
                await appendEvent(client, executionId, 'step.cancelled', { stepId: step.step_id, reason });
            }
        });
    }

    async reconcileInterrupted(): Promise<number> {
        return withTransaction(this.pool, async client => {
            const running = await client.query<ExecutionRow>(
                `UPDATE executions SET status = 'failed', finished_at = clock_timestamp(),
                    duration_ms = GREATEST(0, floor(extract(epoch FROM (clock_timestamp() - started_at)) * 1000))::bigint,
                    error_code = 'SERVER_INTERRUPTED', error_message = 'Server stopped before execution completed.',
                    updated_at = clock_timestamp()
                 WHERE status = 'running' RETURNING *`
            );
            if (running.rows.length === 0) return 0;
            const ids = running.rows.map(row => row.id);
            const failedSteps = await client.query<{ execution_id: string; step_id: string }>(
                `UPDATE execution_steps SET status = 'failed', finished_at = clock_timestamp(),
                    error_code = 'SERVER_INTERRUPTED', error_message = 'Server stopped during this step.'
                 WHERE execution_id = ANY($1::uuid[]) AND status = 'running'
                 RETURNING execution_id, step_id`,
                [ids]
            );
            const cancelledSteps = await client.query<{ execution_id: string; step_id: string }>(
                `UPDATE execution_steps SET status = 'cancelled', finished_at = clock_timestamp(),
                    reason = 'Server stopped before this step started.'
                 WHERE execution_id = ANY($1::uuid[]) AND status = 'pending'
                 RETURNING execution_id, step_id`,
                [ids]
            );
            const failedAttempts = await client.query<{ execution_id: string; step_id: string; attempt: number; item_index: number }>(
                `UPDATE execution_attempts SET status = 'failed', finished_at = clock_timestamp(),
                    error_code = 'SERVER_INTERRUPTED', error_message = 'Server stopped during this attempt.'
                 WHERE execution_id = ANY($1::uuid[]) AND status = 'running'
                 RETURNING execution_id, step_id, attempt, item_index`,
                [ids]
            );
            for (const attempt of failedAttempts.rows) {
                await appendEvent(client, attempt.execution_id, 'attempt.failed', {
                    stepId: attempt.step_id, attempt: attempt.attempt,
                    ...(attempt.item_index < 0 ? {} : { itemIndex: attempt.item_index }),
                    errorCode: 'SERVER_INTERRUPTED', error: 'Server stopped during this attempt.'
                });
            }
            for (const step of failedSteps.rows) {
                await appendEvent(client, step.execution_id, 'step.failed', {
                    stepId: step.step_id, errorCode: 'SERVER_INTERRUPTED',
                    error: 'Server stopped during this step.'
                });
            }
            for (const step of cancelledSteps.rows) {
                await appendEvent(client, step.execution_id, 'step.cancelled', {
                    stepId: step.step_id, reason: 'Server stopped before this step started.'
                });
            }
            for (const row of running.rows) {
                await appendEvent(client, row.id, 'execution.failed', {
                    status: 'failed', errorCode: 'SERVER_INTERRUPTED',
                    error: 'Server stopped before execution completed.', finishedAt: row.finished_at?.toISOString() ?? null
                });
                await recordExecutionFailureAttention(client, {
                    executionId: row.id,
                    jobId: row.job_id,
                    reason: row.error_message ?? 'Server stopped before execution completed.',
                    occurredAt: row.finished_at ?? row.requested_at,
                    detailSnapshot: {
                        errorCode: row.error_code,
                        error: row.error_message,
                        trigger: row.trigger_type,
                        input: row.input,
                        interrupted: true
                    }
                });
                await enqueueTerminalWebhooks(client, row);
            }
            return ids.length;
        });
    }
}

async function insertExecution(
    client: DatabaseClient,
    job: Job,
    input: Record<string, unknown>,
    trigger: ExecutionTrigger,
    scheduledFor: Date | null,
    status: ExecutionStatus,
    skipReason: string | null = null,
    actor?: AuthenticatedActor
): Promise<string> {
    const executionId = randomUUID();
    const terminal = status === 'skipped';
    const inserted = await client.query<ExecutionRow>(
        `INSERT INTO executions(
            id, job_id, job_definition, input, trigger_type, status, scheduled_for,
            finished_at, skip_reason, requested_by_type, requested_by_user_id, requested_by_label
         )
         VALUES (
            $1, $2, $3, $4, $5, $6, $7,
            CASE WHEN $8 THEN clock_timestamp() ELSE NULL END, $9, $10, $11, $12
         )
         RETURNING *`,
        [
            executionId, job.id, job, input, trigger, status, scheduledFor, terminal, skipReason,
            actor === undefined ? 'system' : actor.authType === 'session' ? 'user' : 'api_token',
            actor?.userId ?? null,
            actor?.email ?? 'system'
        ]
    );
    for (const step of [...job.STEPS].sort((a, b) => a.ORDER - b.ORDER)) {
        await client.query(
            `INSERT INTO execution_steps(execution_id, step_id, step_name, step_type, step_order, status, finished_at, reason)
             VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $6 = 'skipped' THEN clock_timestamp() ELSE NULL END, $7)`,
            [executionId, step.ID, step.NAME, step.TYPE, step.ORDER, terminal ? 'skipped' : 'pending', skipReason]
        );
    }
    await appendEvent(client, executionId, terminal ? 'execution.skipped' : 'execution.queued', {
        jobId: job.id, trigger, status, scheduledFor: scheduledFor?.toISOString() ?? null,
        requestedAt: inserted.rows[0]!.requested_at.toISOString(),
        requestedBy: actor?.email ?? 'system',
        ...(skipReason === null ? {} : { reason: skipReason })
    });
    if (terminal) await enqueueTerminalWebhooks(client, inserted.rows[0]!);
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
        requestedBy: mapActorSummary(
            row.requested_by_type,
            row.requested_by_user_id,
            row.requested_by_label
        ),
        startedAt: row.started_at?.toISOString() ?? null,
        finishedAt: row.finished_at?.toISOString() ?? null,
        cancelRequestedAt: row.cancel_requested_at?.toISOString() ?? null,
        cancelRequestedBy: row.cancel_requested_by_type === null
            ? null
            : mapActorSummary(
                row.cancel_requested_by_type,
                row.cancel_requested_by_user_id,
                row.cancel_requested_by_label ?? 'unknown'
            ),
        durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
        error: row.error_message === null ? null : { code: row.error_code, message: row.error_message },
        skipReason: row.skip_reason
    };
}

async function appendEvent(
    client: DatabaseClient,
    executionId: string,
    eventType: string,
    payload: Record<string, unknown>
): Promise<void> {
    await client.query(
        'INSERT INTO execution_events(execution_id, event_type, payload) VALUES ($1, $2, $3::jsonb)',
        [executionId, eventType, JSON.stringify(payload)]
    );
}

async function enqueueTerminalWebhooks(client: DatabaseClient, row: ExecutionRow): Promise<void> {
    const terminalStatuses = new Set<WebhookEventStatus>(['success', 'failed', 'cancelled', 'skipped']);
    if (!terminalStatuses.has(row.status as WebhookEventStatus)) return;
    const status = row.status as WebhookEventStatus;
    const eventType = `execution.${status}`;
    const webhooks = row.job_definition.WEBHOOKS ?? [];
    for (const [subscriptionIndex, webhook] of webhooks.entries()) {
        if (webhook.EVENTS !== undefined && !webhook.EVENTS.includes(status)) continue;
        const deliveryId = randomUUID();
        const payload = {
            event: eventType,
            deliveryId,
            execution: {
                executionId: row.id,
                jobId: row.job_id,
                trigger: row.trigger_type,
                status: row.status,
                scheduledFor: row.scheduled_for?.toISOString() ?? null,
                requestedAt: row.requested_at.toISOString(),
                startedAt: row.started_at?.toISOString() ?? null,
                finishedAt: row.finished_at?.toISOString() ?? null,
                durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
                error: row.error_message === null ? null : { code: row.error_code, message: row.error_message },
                skipReason: row.skip_reason
            }
        };
        await client.query(
            `INSERT INTO webhook_deliveries(
                id, execution_id, event_type, subscription_index, url, payload, status, signing_secret_name
             ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'pending', $7)
             ON CONFLICT (execution_id, event_type, subscription_index) DO NOTHING`,
            [
                deliveryId, row.id, eventType, subscriptionIndex, webhook.URL,
                JSON.stringify(payload), webhook.SIGNING_SECRET ?? null
            ]
        );
    }
}

function mapActorSummary(type: ActorSummary['type'], userId: string | null, label: string): ActorSummary {
    return { type, userId, label };
}

function mapAttempt(row: AttemptRow): StepAttemptLog {
    return compact({
        attempt: row.attempt,
        itemIndex: row.item_index < 0 ? undefined : row.item_index,
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
