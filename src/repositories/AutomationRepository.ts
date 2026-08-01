import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { DatabaseClient, DatabasePool } from '../db/pool.js';
import { withTransaction } from '../db/pool.js';
import { AppError } from '../errors.js';
import type {
    AuthenticatedActor,
    AutomationTrigger,
    AutomationTriggerEvent,
    ExecutionSummary,
    Job,
    PageResponse,
    WebhookEventStatus
} from '../types/index.js';
import type { ExecutionRepository } from './ExecutionRepository.js';

interface TriggerRow {
    id: string;
    target_job_id: string;
    kind: 'webhook' | 'job_completion';
    name: string;
    enabled: boolean;
    source_job_id: string | null;
    terminal_statuses: WebhookEventStatus[] | null;
    token_hash: Buffer | null;
    token_suffix: string | null;
    created_at: Date;
    updated_at: Date;
    last_triggered_at: Date | null;
}

interface EventRow {
    id: string;
    trigger_id: string;
    source_execution_id: string | null;
    queued_execution_id: string | null;
    status: AutomationTriggerEvent['status'];
    reason: string | null;
    attempt_count: number;
    created_at: Date;
    updated_at: Date;
}

export class AutomationRepository {
    constructor(readonly pool: DatabasePool, private readonly executions: ExecutionRepository) {}

    async list(jobId: string): Promise<AutomationTrigger[]> {
        await this.assertJob(jobId);
        const result = await this.pool.query<TriggerRow>(
            `SELECT * FROM automation_triggers
             WHERE target_job_id = $1 OR source_job_id = $1 ORDER BY created_at DESC`, [jobId]
        );
        return result.rows.map(mapTrigger);
    }

    async createWebhook(jobId: string, name: string, actor?: AuthenticatedActor): Promise<{ trigger: AutomationTrigger; token: string }> {
        await this.assertJob(jobId);
        const token = webhookToken();
        const result = await this.pool.query<TriggerRow>(
            `INSERT INTO automation_triggers(id, target_job_id, kind, name, token_hash, token_suffix, created_by_user_id)
             VALUES ($1, $2, 'webhook', $3, $4, $5, $6) RETURNING *`,
            [randomUUID(), jobId, name, hash(token), token.slice(-6), actor?.userId ?? null]
        );
        return { trigger: mapTrigger(result.rows[0]!), token };
    }

    async createChain(jobId: string, name: string, sourceJobId: string, statuses: WebhookEventStatus[], actor?: AuthenticatedActor): Promise<AutomationTrigger> {
        await Promise.all([this.assertJob(jobId), this.assertJob(sourceJobId)]);
        await this.assertNoCycle(sourceJobId, jobId);
        const result = await this.pool.query<TriggerRow>(
            `INSERT INTO automation_triggers(id, target_job_id, kind, name, source_job_id,
                terminal_statuses, created_by_user_id)
             VALUES ($1, $2, 'job_completion', $3, $4, $5, $6) RETURNING *`,
            [randomUUID(), jobId, name, sourceJobId, statuses, actor?.userId ?? null]
        );
        return mapTrigger(result.rows[0]!);
    }

    async update(jobId: string, triggerId: string, patch: { name?: string; enabled?: boolean; terminalStatuses?: WebhookEventStatus[] }): Promise<AutomationTrigger> {
        return withTransaction(this.pool, async client => {
            const current = await this.triggerForUpdate(client, jobId, triggerId);
            if (patch.enabled === true && current.kind === 'job_completion' && !current.enabled) {
                await this.assertNoCycle(current.source_job_id!, current.target_job_id, triggerId, client);
            }
            const result = await client.query<TriggerRow>(
                `UPDATE automation_triggers SET name = COALESCE($3, name), enabled = COALESCE($4, enabled),
                    terminal_statuses = CASE WHEN kind = 'job_completion' AND $5::text[] IS NOT NULL THEN $5 ELSE terminal_statuses END,
                    updated_at = clock_timestamp()
                 WHERE id = $1 AND target_job_id = $2 RETURNING *`,
                [triggerId, jobId, patch.name ?? null, patch.enabled ?? null, patch.terminalStatuses ?? null]
            );
            return mapTrigger(result.rows[0]!);
        });
    }

    async rotateToken(jobId: string, triggerId: string): Promise<{ trigger: AutomationTrigger; token: string }> {
        const token = webhookToken();
        const result = await this.pool.query<TriggerRow>(
            `UPDATE automation_triggers SET token_hash = $3, token_suffix = $4, updated_at = clock_timestamp()
             WHERE id = $1 AND target_job_id = $2 AND kind = 'webhook' RETURNING *`,
            [triggerId, jobId, hash(token), token.slice(-6)]
        );
        if (result.rows[0] === undefined) throw new AppError('TRIGGER_NOT_FOUND', `Webhook trigger ${triggerId} was not found.`, 404);
        return { trigger: mapTrigger(result.rows[0]), token };
    }

    async delete(jobId: string, triggerId: string): Promise<void> {
        const result = await this.pool.query('DELETE FROM automation_triggers WHERE id = $1 AND target_job_id = $2', [triggerId, jobId]);
        if (result.rowCount === 0) throw new AppError('TRIGGER_NOT_FOUND', `Trigger ${triggerId} was not found.`, 404);
    }

    async listEvents(jobId: string, page: number, limit: number): Promise<PageResponse<AutomationTriggerEvent>> {
        await this.assertJob(jobId);
        const [items, count] = await Promise.all([
            this.pool.query<EventRow>(
                `SELECT e.* FROM automation_trigger_events e JOIN automation_triggers t ON t.id = e.trigger_id
                 WHERE t.target_job_id = $1 OR t.source_job_id = $1
                 ORDER BY e.created_at DESC, e.id DESC OFFSET $2 LIMIT $3`, [jobId, (page - 1) * limit, limit]
            ),
            this.pool.query<{ count: string }>(
                `SELECT count(*)::text AS count FROM automation_trigger_events e
                 JOIN automation_triggers t ON t.id = e.trigger_id
                 WHERE t.target_job_id = $1 OR t.source_job_id = $1`, [jobId]
            )
        ]);
        const total = Number(count.rows[0]?.count ?? 0);
        return { items: items.rows.map(mapEvent), page, pageSize: limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) };
    }

    async invokeWebhook(triggerId: string, token: string, input: Record<string, unknown>, idempotencyKey?: string): Promise<ExecutionSummary> {
        const executionId = await withTransaction(this.pool, async client => {
            const result = await client.query<TriggerRow & { definition: Job; current_version: number; job_status: string }>(
                `SELECT t.*, j.definition, j.current_version, j.status AS job_status
                 FROM automation_triggers t JOIN jobs j ON j.id = t.target_job_id
                 WHERE t.id = $1 AND t.kind = 'webhook' FOR UPDATE`, [triggerId]
            );
            const row = result.rows[0];
            if (row === undefined || !row.enabled || row.token_hash === null) throw new AppError('WEBHOOK_NOT_FOUND', 'Webhook trigger was not found.', 404);
            const supplied = hash(token);
            if (supplied.length !== row.token_hash.length || !timingSafeEqual(supplied, row.token_hash)) {
                throw new AppError('INVALID_WEBHOOK_TOKEN', 'Webhook bearer token is invalid.', 401);
            }
            if (row.job_status !== 'active') throw new AppError('JOB_INACTIVE', `Job ${row.target_job_id} is inactive.`, 409);
            const idempotencyHash = idempotencyKey === undefined ? null : hash(idempotencyKey);
            if (idempotencyHash !== null) {
                const existing = await client.query<{ queued_execution_id: string }>(
                    `SELECT queued_execution_id FROM automation_trigger_events
                     WHERE trigger_id = $1 AND idempotency_key_hash = $2 AND queued_execution_id IS NOT NULL`,
                    [triggerId, idempotencyHash]
                );
                if (existing.rows[0] !== undefined) return existing.rows[0].queued_execution_id;
            }
            const queued = await this.executions.enqueueAutomationWithClient(
                client, row.definition, row.current_version, input, 'webhook', triggerId
            );
            await client.query(
                `INSERT INTO automation_trigger_events(id, trigger_id, queued_execution_id,
                    idempotency_key_hash, payload, status)
                 VALUES ($1, $2, $3, $4, $5, 'queued')`,
                [randomUUID(), triggerId, queued, idempotencyHash, input]
            );
            await client.query('UPDATE automation_triggers SET last_triggered_at = clock_timestamp() WHERE id = $1', [triggerId]);
            return queued;
        });
        return (await this.executions.getSummary(executionId))!;
    }

    async dispatchOne(): Promise<boolean> {
        return withTransaction(this.pool, async client => {
            const pending = await client.query<{ id: string; trigger_id: string; source_execution_id: string; target_job_id: string;
                name: string; enabled: boolean; definition: Job; current_version: number; job_status: string }>(
                `SELECT e.id, e.trigger_id, e.source_execution_id, t.target_job_id, t.name, t.enabled,
                    j.definition, j.current_version, j.status AS job_status
                 FROM automation_trigger_events e
                 JOIN automation_triggers t ON t.id = e.trigger_id
                 JOIN jobs j ON j.id = t.target_job_id
                 WHERE e.status = 'pending' AND e.next_attempt_at <= clock_timestamp()
                 ORDER BY e.created_at FOR UPDATE OF e SKIP LOCKED LIMIT 1`
            );
            const item = pending.rows[0];
            if (item === undefined) return false;
            if (!item.enabled || item.job_status !== 'active') {
                await client.query(
                    `UPDATE automation_trigger_events SET status = 'skipped', reason = $2,
                        updated_at = clock_timestamp() WHERE id = $1`,
                    [item.id, !item.enabled ? 'Trigger is disabled.' : 'Target job is inactive.']
                );
                return true;
            }
            const source = await client.query<{ job_id: string; input: Record<string, unknown>; status: string;
                finished_at: Date | null; error_code: string | null; error_message: string | null; skip_reason: string | null }>(
                'SELECT job_id, input, status, finished_at, error_code, error_message, skip_reason FROM executions WHERE id = $1',
                [item.source_execution_id]
            );
            if (source.rows[0] === undefined) {
                await client.query(`UPDATE automation_trigger_events SET status = 'failed', reason = 'Source execution no longer exists.', updated_at = clock_timestamp() WHERE id = $1`, [item.id]);
                return true;
            }
            const steps = await client.query<{ step_id: string; output: unknown }>(
                'SELECT step_id, output FROM execution_steps WHERE execution_id = $1 ORDER BY step_order', [item.source_execution_id]
            );
            const sourceRow = source.rows[0];
            const input = {
                event: { type: 'job_completion', triggerId: item.trigger_id, sourceExecutionId: item.source_execution_id,
                    sourceJobId: sourceRow.job_id, status: sourceRow.status,
                    finishedAt: sourceRow.finished_at?.toISOString() ?? null,
                    error: sourceRow.error_message === null ? null : { code: sourceRow.error_code, message: sourceRow.error_message },
                    skipReason: sourceRow.skip_reason },
                sourceInput: sourceRow.input,
                stepOutputs: Object.fromEntries(steps.rows.map(step => [step.step_id, step.output]))
            };
            if (Buffer.byteLength(JSON.stringify(input), 'utf8') > 1_048_576) {
                await client.query(`UPDATE automation_trigger_events SET status = 'failed', reason = 'Automation input exceeds 1 MB.', updated_at = clock_timestamp() WHERE id = $1`, [item.id]);
                return true;
            }
            const queued = await this.executions.enqueueAutomationWithClient(client, item.definition, item.current_version,
                input, 'job_completion', item.trigger_id, item.source_execution_id);
            await client.query(
                `UPDATE automation_trigger_events SET status = 'queued', queued_execution_id = $2,
                    attempt_count = attempt_count + 1, updated_at = clock_timestamp() WHERE id = $1`, [item.id, queued]
            );
            await client.query('UPDATE automation_triggers SET last_triggered_at = clock_timestamp() WHERE id = $1', [item.trigger_id]);
            return true;
        });
    }

    private async assertJob(jobId: string): Promise<void> {
        const result = await this.pool.query('SELECT 1 FROM jobs WHERE id = $1', [jobId]);
        if (result.rowCount === 0) throw new AppError('JOB_NOT_FOUND', `Job with id ${jobId} not found.`, 404);
    }

    private async triggerForUpdate(client: DatabaseClient, jobId: string, triggerId: string): Promise<TriggerRow> {
        const result = await client.query<TriggerRow>(
            'SELECT * FROM automation_triggers WHERE id = $1 AND target_job_id = $2 FOR UPDATE', [triggerId, jobId]
        );
        if (result.rows[0] === undefined) throw new AppError('TRIGGER_NOT_FOUND', `Trigger ${triggerId} was not found.`, 404);
        return result.rows[0];
    }

    private async assertNoCycle(sourceJobId: string, targetJobId: string, excludeId?: string, client?: DatabaseClient): Promise<void> {
        if (sourceJobId === targetJobId) throw new AppError('AUTOMATION_CYCLE', 'A job cannot trigger itself.', 409);
        const result = await (client ?? this.pool).query(
            `WITH RECURSIVE reachable(job_id) AS (
                SELECT target_job_id FROM automation_triggers
                WHERE kind = 'job_completion' AND enabled AND source_job_id = $1 AND ($3::uuid IS NULL OR id <> $3)
                UNION
                SELECT t.target_job_id FROM automation_triggers t JOIN reachable r ON t.source_job_id = r.job_id
                WHERE t.kind = 'job_completion' AND t.enabled AND ($3::uuid IS NULL OR t.id <> $3)
             ) SELECT 1 FROM reachable WHERE job_id = $2 LIMIT 1`,
            [targetJobId, sourceJobId, excludeId ?? null]
        );
        if ((result.rowCount ?? 0) > 0) throw new AppError('AUTOMATION_CYCLE', 'This job chain would create a cycle.', 409);
    }
}

function webhookToken(): string { return 'bj_hook_' + randomBytes(32).toString('base64url'); }
function hash(value: string): Buffer { return createHash('sha256').update(value, 'utf8').digest(); }

function mapTrigger(row: TriggerRow): AutomationTrigger {
    return { triggerId: row.id, targetJobId: row.target_job_id, kind: row.kind, name: row.name,
        enabled: row.enabled, sourceJobId: row.source_job_id, terminalStatuses: row.terminal_statuses,
        tokenSuffix: row.token_suffix, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
        lastTriggeredAt: row.last_triggered_at?.toISOString() ?? null };
}

function mapEvent(row: EventRow): AutomationTriggerEvent {
    return { eventId: row.id, triggerId: row.trigger_id, sourceExecutionId: row.source_execution_id,
        queuedExecutionId: row.queued_execution_id, status: row.status, reason: row.reason,
        attemptCount: row.attempt_count, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() };
}
