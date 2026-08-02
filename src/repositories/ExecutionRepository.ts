import { randomUUID } from 'node:crypto';
import type { DatabaseClient, DatabasePool } from '../db/pool.js';
import { withTransaction } from '../db/pool.js';
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
import { coalesceOccurrences, nextOccurrence } from '../utils/cron.js';
import { dependencyClosure, dependentClosure } from '../utils/jobGraph.js';
import { idempotencyHashes } from '../utils/idempotency.js';
import { resolveJobInput, validateJobInput } from '../utils/inputSchema.js';

interface ExecutionRow {
    id: string;
    job_id: string;
    job_definition: Job;
    job_version: number | null;
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
    queue_name: string;
    priority: number;
    claimed_by_worker_id: string | null;
    lease_expires_at: Date | null;
    parent_execution_id: string | null;
    automation_trigger_id: string | null;
    replay_source_execution_id: string | null;
    resume_step_id: string | null;
    test_selected_step_id: string | null;
    suppress_side_effects: boolean;
    concurrency_key: string | null;
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
    stepIds?: ReadonlySet<string>;
    reusedStepResults?: Record<string, StepLog>;
}

interface InsertExecutionOptions {
    replaySourceExecutionId?: string;
    resumeStepId?: string;
    testSelectedStepId?: string;
    suppressSideEffects?: boolean;
    initialSteps?: Record<string, { status: StepStatus; output?: unknown; reason?: string }>;
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
    private readonly directWorkerId: string = randomUUID();
    constructor(readonly pool: DatabasePool) {}

    async enqueueManual(
        jobId: string,
        input: unknown = undefined,
        actor?: AuthenticatedActor,
        options: { inputProvided?: boolean; idempotencyKey?: string } = {}
    ): Promise<ExecutionSummary> {
        const executionId = await withTransaction(this.pool, async client => {
            const inputProvided = options.inputProvided ?? true;
            const normalizedRequestInput = inputProvided ? validateJobInput({ INPUT_SCHEMA: undefined } as unknown as Job, input) : undefined;
            const hashes = options.idempotencyKey === undefined || actor === undefined
                ? undefined
                : idempotencyHashes(actor, options.idempotencyKey, { inputProvided, input: normalizedRequestInput });
            if (hashes !== undefined) {
                await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [
                    hashes.actorScopeHash.toString('hex'), `${jobId}:manual_run:${hashes.keyHash.toString('hex')}`
                ]);
                const existing = await client.query<{ request_hash: Buffer; execution_id: string }>(
                    `SELECT request_hash, execution_id FROM execution_idempotency
                     WHERE actor_scope_hash = $1 AND job_id = $2 AND operation = 'manual_run' AND key_hash = $3`,
                    [hashes.actorScopeHash, jobId, hashes.keyHash]
                );
                const row = existing.rows[0];
                if (row !== undefined) {
                    if (!row.request_hash.equals(hashes.requestHash)) {
                        throw new AppError('IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key was already used with different input.', 409);
                    }
                    return row.execution_id;
                }
            }
            const result = await client.query<{ definition: Job; current_version: number }>(
                'SELECT definition, current_version FROM jobs WHERE id = $1 FOR UPDATE', [jobId]
            );
            const row = result.rows[0];
            if (row === undefined) throw new AppError('JOB_NOT_FOUND', `Job with id ${jobId} not found.`, 404);
            const resolvedInput = resolveJobInput(row.definition, input, inputProvided);
            const status = await applyOverlapPolicy(client, row.definition, resolvedInput, 'triggered');
            const id = await insertExecution(client, row.definition, resolvedInput, 'manual', null, status,
                status === 'skipped' ? 'overlap' : null, actor, row.current_version);
            if (hashes !== undefined) {
                await client.query(
                    `INSERT INTO execution_idempotency(actor_scope_hash, job_id, operation, key_hash, request_hash, execution_id)
                     VALUES ($1, $2, 'manual_run', $3, $4, $5)`,
                    [hashes.actorScopeHash, jobId, hashes.keyHash, hashes.requestHash, id]
                );
            }
            return id;
        });
        return (await this.getSummary(executionId))!;
    }

    async validateRunInput(jobId: string, input: unknown, inputProvided: boolean): Promise<{ valid: true; input: Record<string, unknown> }> {
        const result = await this.pool.query<{ definition: Job }>('SELECT definition FROM jobs WHERE id = $1', [jobId]);
        const job = result.rows[0]?.definition;
        if (job === undefined) throw new AppError('JOB_NOT_FOUND', `Job with id ${jobId} not found.`, 404);
        return { valid: true, input: resolveJobInput(job, input, inputProvided) };
    }

    async enqueueReplay(
        sourceExecutionId: string,
        actor: AuthenticatedActor,
        options: { useCurrentDefinition?: boolean; resumeStepId?: string } = {}
    ): Promise<ExecutionSummary> {
        const executionId = await withTransaction(this.pool, async client => {
            const sourceResult = await client.query<ExecutionRow>('SELECT * FROM executions WHERE id = $1 FOR UPDATE', [sourceExecutionId]);
            const source = sourceResult.rows[0];
            if (source === undefined) throw new AppError('EXECUTION_NOT_FOUND', `Execution ${sourceExecutionId} not found.`, 404);
            let definition = source.job_definition;
            let version = source.job_version;
            if (options.useCurrentDefinition === true) {
                if (options.resumeStepId !== undefined) {
                    throw new AppError('RESUME_REQUIRES_SNAPSHOT', 'Step resume always uses the stored definition snapshot.', 422);
                }
                const current = await client.query<{ definition: Job; current_version: number }>('SELECT definition, current_version FROM jobs WHERE id = $1', [source.job_id]);
                if (current.rows[0] === undefined) throw new AppError('JOB_NOT_FOUND', `Job with id ${source.job_id} not found.`, 404);
                definition = current.rows[0].definition;
                version = current.rows[0].current_version;
            }
            validateJobInput(definition, source.input);
            let initialSteps: InsertExecutionOptions['initialSteps'];
            if (options.resumeStepId !== undefined) {
                if (source.status !== 'failed' && source.status !== 'cancelled') {
                    throw new AppError('RESUME_SOURCE_NOT_TERMINAL_FAILURE', 'Step resume requires a failed or cancelled execution.', 409);
                }
                const selected = definition.STEPS.find(step => step.ID === options.resumeStepId);
                if (selected === undefined) throw new AppError('RESUME_STEP_NOT_FOUND', `Step ${options.resumeStepId} is not in the stored definition.`, 404);
                if (selected.REPLAY_SAFE !== true) throw new AppError('STEP_NOT_REPLAY_SAFE', `Step ${selected.ID} is not marked REPLAY_SAFE.`, 409);
                const selectedResult = await client.query<{ status: StepStatus }>(
                    'SELECT status FROM execution_steps WHERE execution_id = $1 AND step_id = $2', [sourceExecutionId, selected.ID]
                );
                if (selectedResult.rows[0]?.status !== 'failed') {
                    throw new AppError('RESUME_STEP_NOT_FAILED', 'The selected step must have failed in the source execution.', 409);
                }
                const nodes = definition.STEPS.map(step => ({ id: step.ID, dependsOn: step.DEPENDS_ON ?? [] }));
                const rerun = dependentClosure(nodes, selected.ID);
                const sourceSteps = await client.query<StepRow>('SELECT * FROM execution_steps WHERE execution_id = $1', [sourceExecutionId]);
                initialSteps = {};
                for (const step of sourceSteps.rows) {
                    if (rerun.has(step.step_id)) continue;
                    if (step.status === 'success' || step.status === 'reused') {
                        initialSteps[step.step_id] = { status: 'reused', output: step.output, reason: 'Output reused from source execution.' };
                    } else {
                        initialSteps[step.step_id] = { status: 'skipped', reason: 'Step is outside the resume dependency closure.' };
                    }
                }
            }
            const status = await applyOverlapPolicy(client, definition, source.input, 'triggered');
            return insertExecution(client, definition, source.input, 'replay', null, status,
                status === 'skipped' ? 'overlap' : null, actor, version, null, null, {
                    replaySourceExecutionId: sourceExecutionId,
                    ...(options.resumeStepId === undefined ? {} : { resumeStepId: options.resumeStepId }),
                    ...(initialSteps === undefined ? {} : { initialSteps })
                });
        });
        return (await this.getSummary(executionId))!;
    }

    async enqueueTest(
        draft: Job,
        selectedStepId: string,
        input: unknown,
        inputProvided: boolean,
        actor: AuthenticatedActor
    ): Promise<ExecutionSummary> {
        const selected = draft.STEPS.find(step => step.ID === selectedStepId);
        if (selected === undefined) throw new AppError('TEST_STEP_NOT_FOUND', `Step ${selectedStepId} is not in the draft.`, 422);
        const closure = dependencyClosure(draft.STEPS.map(step => ({ id: step.ID, dependsOn: step.DEPENDS_ON ?? [] })), selectedStepId);
        const initialSteps: NonNullable<InsertExecutionOptions['initialSteps']> = {};
        for (const step of draft.STEPS) {
            if (!closure.has(step.ID)) initialSteps[step.ID] = { status: 'skipped', reason: 'Step is outside the selected test dependency closure.' };
        }
        const resolvedInput = resolveJobInput(draft, input, inputProvided);
        const executionId = await withTransaction(this.pool, client => insertExecution(
            client, draft, resolvedInput, 'test', null, 'queued', null, actor, null, null, null,
            { testSelectedStepId: selectedStepId, suppressSideEffects: true, initialSteps }
        ));
        return (await this.getSummary(executionId))!;
    }

    async enqueueManualWithClient(
        client: DatabaseClient,
        job: Job,
        input: Record<string, unknown>,
        actor: AuthenticatedActor
    ): Promise<string> {
        const version = await client.query<{ current_version: number }>(
            'SELECT current_version FROM jobs WHERE id = $1', [job.id]
        );
        const resolvedInput = validateJobInput(job, input);
        const status = await applyOverlapPolicy(client, job, resolvedInput, 'triggered');
        return insertExecution(client, job, resolvedInput, 'manual', null, status,
            status === 'skipped' ? 'overlap' : null, actor, version.rows[0]?.current_version ?? null);
    }

    async enqueueAutomationWithClient(
        client: DatabaseClient,
        job: Job,
        jobVersion: number,
        input: Record<string, unknown>,
        trigger: 'webhook' | 'job_completion',
        automationTriggerId: string,
        parentExecutionId: string | null = null
    ): Promise<string> {
        const resolvedInput = validateJobInput(job, input);
        const status = await applyOverlapPolicy(client, job, resolvedInput, 'triggered');
        return insertExecution(client, job, resolvedInput, trigger, null, status,
            status === 'skipped' ? 'overlap' : null, undefined, jobVersion, parentExecutionId, automationTriggerId);
    }

    async processDueJobs(now?: Date, limit = 100): Promise<number> {
        return withTransaction(this.pool, async client => {
            const effectiveNow = now ?? (await client.query<{ now: Date }>(
                'SELECT clock_timestamp() AS now'
            )).rows[0]!.now;
            const due = await client.query<{ id: string; definition: Job; schedule: string; timezone: string; current_version: number }>(
                `SELECT id, definition, schedule, timezone, current_version
                 FROM jobs
                 WHERE status = 'active' AND schedule IS NOT NULL AND next_run_at <= $1
                 ORDER BY next_run_at, id
                 FOR UPDATE SKIP LOCKED
                 LIMIT $2`,
                [effectiveNow, limit]
            );
            for (const row of due.rows) {
                const occurrence = coalesceOccurrences(row.schedule, row.timezone, effectiveNow);
                const existing = await client.query<{ id: string }>(
                    `SELECT id FROM executions WHERE job_id = $1 AND scheduled_for = $2
                     AND trigger_type IN ('scheduled', 'backfill')`,
                    [row.id, occurrence.scheduledFor]
                );
                if (existing.rows[0] === undefined) {
                    const input = resolveJobInput(row.definition, undefined, false);
                    const status = await applyOverlapPolicy(client, row.definition, input, 'scheduled');
                    await insertExecution(client, row.definition, input, 'scheduled', occurrence.scheduledFor, status,
                        status === 'skipped' ? 'overlap' : null, undefined, row.current_version);
                }
                await client.query(
                    'UPDATE jobs SET next_run_at = $2, updated_at = clock_timestamp() WHERE id = $1',
                    [row.id, occurrence.nextRunAt]
                );
            }
            return due.rows.length;
        });
    }

    async previewBackfill(jobId: string, from: Date, to: Date): Promise<{
        jobId: string;
        from: string;
        to: string;
        occurrences: Array<{ scheduledFor: string; existingExecutionId: string | null }>;
    }> {
        const result = await this.pool.query<{ definition: Job; schedule: string | null; timezone: string }>(
            'SELECT definition, schedule, timezone FROM jobs WHERE id = $1', [jobId]
        );
        const row = result.rows[0];
        if (row === undefined) throw new AppError('JOB_NOT_FOUND', `Job with id ${jobId} not found.`, 404);
        if (row.schedule === null) throw new AppError('BACKFILL_REQUIRES_SCHEDULE', 'Backfills require a scheduled job.', 409);
        const occurrences = enumerateOccurrences(row.schedule, row.timezone, from, to);
        const existing = occurrences.length === 0 ? { rows: [] as Array<{ id: string; scheduled_for: Date }> } : await this.pool.query<{ id: string; scheduled_for: Date }>(
            `SELECT id, scheduled_for FROM executions
             WHERE job_id = $1 AND trigger_type IN ('scheduled', 'backfill') AND scheduled_for = ANY($2::timestamptz[])`,
            [jobId, occurrences]
        );
        const byTime = new Map(existing.rows.map(item => [item.scheduled_for.toISOString(), item.id]));
        return {
            jobId, from: from.toISOString(), to: to.toISOString(),
            occurrences: occurrences.map(item => ({ scheduledFor: item.toISOString(), existingExecutionId: byTime.get(item.toISOString()) ?? null }))
        };
    }

    async applyBackfill(
        jobId: string,
        from: Date,
        to: Date,
        input: unknown,
        inputProvided: boolean,
        actor: AuthenticatedActor,
        idempotencyKey?: string
    ): Promise<{ jobId: string; executions: Array<{ scheduledFor: string; executionId: string; existing: boolean }> }> {
        return withTransaction(this.pool, async client => {
            const normalizedRequestInput = inputProvided ? validateJobInput({ INPUT_SCHEMA: undefined } as unknown as Job, input) : undefined;
            const hashes = idempotencyKey === undefined ? undefined : idempotencyHashes(actor, idempotencyKey, {
                from: from.toISOString(), to: to.toISOString(), inputProvided, input: normalizedRequestInput
            });
            if (hashes !== undefined) {
                await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [
                    hashes.actorScopeHash.toString('hex'), `${jobId}:backfill:${hashes.keyHash.toString('hex')}`
                ]);
                const prior = await client.query<{ request_hash: Buffer; response_snapshot: { jobId: string; executions: Array<{ scheduledFor: string; executionId: string; existing: boolean }> } }>(
                    `SELECT request_hash, response_snapshot FROM execution_idempotency
                     WHERE actor_scope_hash = $1 AND job_id = $2 AND operation = 'backfill' AND key_hash = $3`,
                    [hashes.actorScopeHash, jobId, hashes.keyHash]
                );
                if (prior.rows[0] !== undefined) {
                    if (!prior.rows[0].request_hash.equals(hashes.requestHash)) {
                        throw new AppError('IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key was already used with different backfill parameters.', 409);
                    }
                    return prior.rows[0].response_snapshot;
                }
            }
            const jobResult = await client.query<{ definition: Job; schedule: string | null; timezone: string; current_version: number }>(
                'SELECT definition, schedule, timezone, current_version FROM jobs WHERE id = $1 FOR UPDATE', [jobId]
            );
            const row = jobResult.rows[0];
            if (row === undefined) throw new AppError('JOB_NOT_FOUND', `Job with id ${jobId} not found.`, 404);
            if (row.schedule === null) throw new AppError('BACKFILL_REQUIRES_SCHEDULE', 'Backfills require a scheduled job.', 409);
            const occurrences = enumerateOccurrences(row.schedule, row.timezone, from, to);
            const resolvedInput = resolveJobInput(row.definition, input, inputProvided);
            const executions: Array<{ scheduledFor: string; executionId: string; existing: boolean }> = [];
            for (const occurrence of occurrences) {
                const existing = await client.query<{ id: string }>(
                    `SELECT id FROM executions WHERE job_id = $1 AND scheduled_for = $2
                     AND trigger_type IN ('scheduled', 'backfill')`, [jobId, occurrence]
                );
                if (existing.rows[0] !== undefined) {
                    executions.push({ scheduledFor: occurrence.toISOString(), executionId: existing.rows[0].id, existing: true });
                    continue;
                }
                const status = await applyOverlapPolicy(client, row.definition, resolvedInput, 'triggered');
                const executionId = await insertExecution(client, row.definition, resolvedInput, 'backfill', occurrence, status,
                    status === 'skipped' ? 'overlap' : null, actor, row.current_version);
                executions.push({ scheduledFor: occurrence.toISOString(), executionId, existing: false });
            }
            const response = { jobId, executions };
            if (hashes !== undefined) {
                await client.query(
                    `INSERT INTO execution_idempotency(actor_scope_hash, job_id, operation, key_hash, request_hash, execution_id, response_snapshot)
                     VALUES ($1, $2, 'backfill', $3, $4, $5, $6::jsonb)`,
                    [hashes.actorScopeHash, jobId, hashes.keyHash, hashes.requestHash,
                        executions.find(item => !item.existing)?.executionId ?? executions[0]?.executionId ?? null,
                        JSON.stringify(response)]
                );
            }
            return response;
        });
    }

    async claimOldestQueued(workerId = this.directWorkerId, queues: string[] = ['default'], leaseMs = 20_000): Promise<ClaimedExecution | undefined> {
        return withTransaction(this.pool, async client => {
                await client.query(
                    `INSERT INTO worker_instances(id, name, queues, concurrency)
                     VALUES ($1, 'direct repository worker', $2, 1)
                     ON CONFLICT (id) DO UPDATE SET last_heartbeat_at = clock_timestamp(), stopped_at = NULL`,
                    [workerId, queues]
                );
                await client.query(
                    `INSERT INTO queue_policies(name) SELECT unnest($1::text[]) ON CONFLICT DO NOTHING`, [queues]
                );
                await client.query(
                    `SELECT name FROM queue_policies WHERE name = ANY($1::text[]) ORDER BY name FOR UPDATE`, [queues]
                );
                const claimed = await client.query<ExecutionRow>(
                    `WITH candidate AS (
                        SELECT e.id FROM executions e
                        JOIN queue_policies p ON p.name = e.queue_name
                        WHERE e.status = 'queued' AND e.queue_name = ANY($2::text[])
                          AND NOT p.paused
                          AND (p.max_running IS NULL OR (
                              SELECT count(*) FROM executions qr
                              WHERE qr.queue_name = e.queue_name AND qr.status = 'running'
                          ) < p.max_running)
                          AND (
                              SELECT count(*) FROM executions running
                              WHERE running.job_id = e.job_id AND running.status = 'running'
                          ) < coalesce((e.job_definition->'RUN_POLICY'->>'MAX_RUNNING')::integer, 1)
                          AND (e.concurrency_key IS NULL OR NOT EXISTS (
                              SELECT 1 FROM executions keyed
                              WHERE keyed.job_id = e.job_id AND keyed.status = 'running'
                                AND keyed.concurrency_key = e.concurrency_key
                          ))
                          AND (p.max_starts IS NULL OR NOT EXISTS (
                              SELECT 1 FROM queue_rate_windows rw
                              WHERE rw.queue_name = e.queue_name
                                AND rw.window_started_at = to_timestamp(
                                    floor(extract(epoch FROM clock_timestamp()) * 1000 / p.interval_ms) * p.interval_ms / 1000.0
                                )
                                AND rw.starts_count >= p.max_starts
                          ))
                        ORDER BY e.priority DESC, e.requested_at, e.id
                        FOR UPDATE SKIP LOCKED
                        LIMIT 1
                     )
                     UPDATE executions e
                     SET status = 'running', started_at = clock_timestamp(), claimed_by_worker_id = $1,
                         lease_expires_at = clock_timestamp() + ($3::integer * interval '1 millisecond'),
                         updated_at = clock_timestamp()
                     FROM candidate WHERE e.id = candidate.id RETURNING e.*`,
                    [workerId, queues, leaseMs]
                );
                const row = claimed.rows[0];
                if (row === undefined || row.started_at === null) return undefined;
                await client.query(
                    `INSERT INTO queue_rate_windows(queue_name, window_started_at, starts_count)
                     SELECT p.name,
                            to_timestamp(floor(extract(epoch FROM clock_timestamp()) * 1000 / p.interval_ms) * p.interval_ms / 1000.0),
                            1
                     FROM queue_policies p WHERE p.name = $1 AND p.max_starts IS NOT NULL
                     ON CONFLICT (queue_name, window_started_at)
                     DO UPDATE SET starts_count = queue_rate_windows.starts_count + 1`,
                    [row.queue_name]
                );
                await client.query(
                    'UPDATE jobs SET last_run_at = $2, updated_at = clock_timestamp() WHERE id = $1',
                    [row.job_id, row.started_at]
                );
                await appendEvent(client, row.id, 'execution.running', {
                    jobId: row.job_id, workerId, queue: row.queue_name, startedAt: row.started_at.toISOString()
                });
                let stepIds: Set<string> | undefined;
                if (row.resume_step_id !== null) {
                    stepIds = dependentClosure(
                        row.job_definition.STEPS.map(step => ({ id: step.ID, dependsOn: step.DEPENDS_ON ?? [] })),
                        row.resume_step_id
                    );
                } else if (row.test_selected_step_id !== null) {
                    stepIds = dependencyClosure(
                        row.job_definition.STEPS.map(step => ({ id: step.ID, dependsOn: step.DEPENDS_ON ?? [] })),
                        row.test_selected_step_id
                    );
                }
                const reused = await client.query<StepRow>(
                    `SELECT * FROM execution_steps WHERE execution_id = $1 AND status = 'reused'`, [row.id]
                );
                const reusedStepResults = Object.fromEntries(reused.rows.map(step => [
                    step.step_id, mapStep(step, [])
                ]));
                return {
                    executionId: row.id, jobId: row.job_id, jobDefinition: row.job_definition,
                    requestedAt: row.requested_at, startedAt: row.started_at, input: row.input,
                    ...(stepIds === undefined ? {} : { stepIds }),
                    ...(reused.rows.length === 0 ? {} : { reusedStepResults })
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
                await enqueueTerminalAutomations(client, cancelled.rows[0]!);
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
            if (status === 'failed' && !row.suppress_side_effects) {
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
            await enqueueTerminalAutomations(client, row);
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
                if (!row.suppress_side_effects) await recordExecutionFailureAttention(client, {
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
                await enqueueTerminalAutomations(client, row);
            }
            return ids.length;
        });
    }

    async reconcileExpiredLeases(limit = 100): Promise<number> {
        return withTransaction(this.pool, async client => {
            const expired = await client.query<ExecutionRow>(
                `WITH candidates AS (
                    SELECT id FROM executions
                    WHERE status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at < clock_timestamp())
                    ORDER BY lease_expires_at NULLS FIRST, started_at
                    FOR UPDATE SKIP LOCKED LIMIT $1
                 )
                 UPDATE executions e SET status = 'failed', finished_at = clock_timestamp(),
                    duration_ms = GREATEST(0, floor(extract(epoch FROM (clock_timestamp() - started_at)) * 1000))::bigint,
                    error_code = 'WORKER_LOST', error_message = 'The worker lease expired before execution completed.',
                    updated_at = clock_timestamp()
                 FROM candidates WHERE e.id = candidates.id RETURNING e.*`, [limit]
            );
            if (expired.rows.length === 0) return 0;
            const ids = expired.rows.map(row => row.id);
            await client.query(
                `UPDATE execution_steps SET status = CASE WHEN status = 'running' THEN 'failed' ELSE 'cancelled' END,
                    finished_at = clock_timestamp(), error_code = CASE WHEN status = 'running' THEN 'WORKER_LOST' ELSE NULL END,
                    error_message = CASE WHEN status = 'running' THEN 'The worker lease expired during this step.' ELSE NULL END,
                    reason = CASE WHEN status = 'pending' THEN 'The worker was lost before this step started.' ELSE reason END
                 WHERE execution_id = ANY($1::uuid[]) AND status IN ('pending', 'running')`, [ids]
            );
            await client.query(
                `UPDATE execution_attempts SET status = 'failed', finished_at = clock_timestamp(),
                    error_code = 'WORKER_LOST', error_message = 'The worker lease expired during this attempt.'
                 WHERE execution_id = ANY($1::uuid[]) AND status = 'running'`, [ids]
            );
            for (const row of expired.rows) {
                await appendEvent(client, row.id, 'execution.failed', {
                    status: 'failed', errorCode: 'WORKER_LOST',
                    error: row.error_message, finishedAt: row.finished_at?.toISOString() ?? null
                });
                if (!row.suppress_side_effects) await recordExecutionFailureAttention(client, {
                    executionId: row.id, jobId: row.job_id,
                    reason: row.error_message ?? 'The worker lease expired before execution completed.',
                    occurredAt: row.finished_at ?? row.requested_at,
                    detailSnapshot: { errorCode: 'WORKER_LOST', trigger: row.trigger_type, input: row.input, workerLost: true }
                });
                await enqueueTerminalWebhooks(client, row);
                await enqueueTerminalAutomations(client, row);
            }
            return expired.rows.length;
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
    actor?: AuthenticatedActor,
    jobVersion: number | null = null,
    parentExecutionId: string | null = null,
    automationTriggerId: string | null = null,
    options: InsertExecutionOptions = {}
): Promise<string> {
    const executionId = randomUUID();
    const terminal = status === 'skipped';
    const queue = job.QUEUE ?? 'default';
    const concurrencyKey = resolveConcurrencyKey(job, input);
    await client.query('INSERT INTO queue_policies(name) VALUES ($1) ON CONFLICT DO NOTHING', [queue]);
    const inserted = await client.query<ExecutionRow>(
        `INSERT INTO executions(
            id, job_id, job_definition, job_version, input, trigger_type, status, scheduled_for,
            finished_at, skip_reason, requested_by_type, requested_by_user_id, requested_by_label,
            queue_name, priority, parent_execution_id, automation_trigger_id, concurrency_key,
            replay_source_execution_id, resume_step_id, test_selected_step_id, suppress_side_effects
         )
         VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8,
            CASE WHEN $9 THEN clock_timestamp() ELSE NULL END, $10, $11, $12, $13, $14, $15, $16, $17,
            $18, $19, $20, $21, $22
         )
         RETURNING *`,
        [
            executionId, job.id, job, jobVersion, input, trigger, status, scheduledFor, terminal, skipReason,
            actor === undefined ? 'system' : actor.authType === 'session' ? 'user' : 'api_token',
            actor?.userId ?? null, actor?.email ?? 'system', queue, job.PRIORITY ?? 0,
            parentExecutionId, automationTriggerId, concurrencyKey,
            options.replaySourceExecutionId ?? null, options.resumeStepId ?? null,
            options.testSelectedStepId ?? null, options.suppressSideEffects ?? false
        ]
    );
    for (const step of [...job.STEPS].sort((a, b) => a.ORDER - b.ORDER)) {
        const initial = options.initialSteps?.[step.ID];
        const stepStatus: StepStatus = terminal ? 'skipped' : initial?.status ?? 'pending';
        const reason = terminal ? skipReason : initial?.reason ?? null;
        await client.query(
            `INSERT INTO execution_steps(execution_id, step_id, step_name, step_type, step_order, status, finished_at, output, reason)
             VALUES ($1, $2, $3, $4, $5, $6,
                CASE WHEN $6 IN ('skipped', 'reused') THEN clock_timestamp() ELSE NULL END, $7, $8)`,
            [executionId, step.ID, step.NAME, step.TYPE, step.ORDER, stepStatus,
                initial?.output === undefined ? null : JSON.stringify(initial.output), reason]
        );
        if (!terminal && (stepStatus === 'skipped' || stepStatus === 'reused')) {
            await appendEvent(client, executionId, `step.${stepStatus}`, {
                stepId: step.ID, status: stepStatus, reason,
                ...(initial?.output === undefined ? {} : { output: initial.output })
            });
        }
    }
    await appendEvent(client, executionId, terminal ? 'execution.skipped' : 'execution.queued', {
        jobId: job.id, trigger, status, scheduledFor: scheduledFor?.toISOString() ?? null,
        requestedAt: inserted.rows[0]!.requested_at.toISOString(),
        requestedBy: actor?.email ?? 'system',
        ...(skipReason === null ? {} : { reason: skipReason })
    });
    if (terminal && !options.suppressSideEffects) {
        await enqueueTerminalWebhooks(client, inserted.rows[0]!);
        await enqueueTerminalAutomations(client, inserted.rows[0]!);
    }
    return executionId;
}

function mapSummary(row: ExecutionRow): ExecutionSummary {
    return {
        executionId: row.id,
        logId: row.id,
        jobId: row.job_id,
        jobVersion: row.job_version,
        queue: row.queue_name,
        priority: row.priority,
        concurrencyKey: row.concurrency_key,
        parentExecutionId: row.parent_execution_id,
        automationTriggerId: row.automation_trigger_id,
        replaySourceExecutionId: row.replay_source_execution_id,
        resumeStepId: row.resume_step_id,
        testSelectedStepId: row.test_selected_step_id,
        suppressSideEffects: row.suppress_side_effects,
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
        queueDelayMs: row.started_at === null ? null : Math.max(0, row.started_at.getTime() - row.requested_at.getTime()),
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
    if (row.suppress_side_effects) return;
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

async function enqueueTerminalAutomations(client: DatabaseClient, row: ExecutionRow): Promise<void> {
    if (row.suppress_side_effects) return;
    const terminalStatuses = new Set<WebhookEventStatus>(['success', 'failed', 'cancelled', 'skipped']);
    if (!terminalStatuses.has(row.status as WebhookEventStatus)) return;
    const triggers = await client.query<{ id: string }>(
        `SELECT id FROM automation_triggers
         WHERE kind = 'job_completion' AND enabled AND source_job_id = $1 AND $2 = ANY(terminal_statuses)
         ORDER BY created_at`, [row.job_id, row.status]
    );
    for (const trigger of triggers.rows) {
        await client.query(
            `INSERT INTO automation_trigger_events(id, trigger_id, source_execution_id, status)
             VALUES ($1, $2, $3, 'pending') ON CONFLICT DO NOTHING`,
            [randomUUID(), trigger.id, row.id]
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

export function resolveConcurrencyKey(job: Job, input: Record<string, unknown>): string | null {
    const path = job.RUN_POLICY?.KEY;
    if (path === undefined) return null;
    const segments = path.split('.');
    let value: unknown = { input };
    for (const segment of segments) {
        if (value === null || typeof value !== 'object' || Array.isArray(value) ||
            !Object.prototype.hasOwnProperty.call(value, segment)) {
            throw new AppError('CONCURRENCY_KEY_NOT_FOUND', `RUN_POLICY.KEY ${path} could not be resolved.`, 422);
        }
        value = (value as Record<string, unknown>)[segment];
    }
    if (value === null || !['string', 'number', 'boolean'].includes(typeof value)) {
        throw new AppError('CONCURRENCY_KEY_NOT_SCALAR', `RUN_POLICY.KEY ${path} must resolve to a string, number, or boolean.`, 422);
    }
    return JSON.stringify(value);
}

async function applyOverlapPolicy(
    client: DatabaseClient,
    job: Job,
    input: Record<string, unknown>,
    kind: 'scheduled' | 'triggered'
): Promise<ExecutionStatus> {
    const mode = kind === 'scheduled'
        ? job.RUN_POLICY?.OVERLAP?.SCHEDULED ?? 'skip'
        : job.RUN_POLICY?.OVERLAP?.TRIGGERED ?? 'queue';
    if (mode === 'queue') return 'queued';
    const key = resolveConcurrencyKey(job, input);
    const active = await client.query<ExecutionRow>(
        `SELECT * FROM executions
         WHERE job_id = $1 AND status IN ('queued', 'running')
           AND ($2::text IS NULL OR concurrency_key IS NOT DISTINCT FROM $2)
         ORDER BY requested_at, id FOR UPDATE LIMIT 1`,
        [job.id, key]
    );
    const oldest = active.rows[0];
    if (oldest === undefined) return 'queued';
    if (mode === 'skip') return 'skipped';
    if (oldest.status === 'queued') {
        const cancelled = await client.query<ExecutionRow>(
            `UPDATE executions SET status = 'cancelled', cancel_requested_at = clock_timestamp(),
                finished_at = clock_timestamp(), error_code = 'OVERLAP_CANCELLED',
                error_message = 'Cancelled by the job overlap policy.', updated_at = clock_timestamp()
             WHERE id = $1 RETURNING *`, [oldest.id]
        );
        await client.query(
            `UPDATE execution_steps SET status = 'cancelled', finished_at = clock_timestamp(),
                reason = 'Cancelled by the job overlap policy.'
             WHERE execution_id = $1 AND status = 'pending'`, [oldest.id]
        );
        await appendEvent(client, oldest.id, 'execution.cancelled', { reason: 'Cancelled by the job overlap policy.' });
        if (cancelled.rows[0] !== undefined) {
            await enqueueTerminalWebhooks(client, cancelled.rows[0]);
            await enqueueTerminalAutomations(client, cancelled.rows[0]);
        }
    } else {
        await client.query(
            `UPDATE executions SET cancel_requested_at = coalesce(cancel_requested_at, clock_timestamp()),
                updated_at = clock_timestamp() WHERE id = $1`, [oldest.id]
        );
        await appendEvent(client, oldest.id, 'execution.cancel_requested', { reason: 'Cancelled by the job overlap policy.' });
    }
    return 'queued';
}

function enumerateOccurrences(schedule: string, timezone: string, from: Date, to: Date): Date[] {
    if (from >= to) throw new AppError('INVALID_BACKFILL_RANGE', 'from must be earlier than to.', 422);
    const occurrences: Date[] = [];
    let cursor = new Date(from.getTime() - 1);
    while (true) {
        cursor = nextOccurrence(schedule, timezone, cursor);
        if (cursor > to) break;
        occurrences.push(cursor);
        if (occurrences.length > 500) {
            throw new AppError('BACKFILL_LIMIT_EXCEEDED', 'A backfill request may contain at most 500 occurrences.', 422);
        }
    }
    return occurrences;
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
