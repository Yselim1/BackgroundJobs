import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseClient, DatabasePool } from '../db/pool.js';
import { withTransaction } from '../db/pool.js';
import { AppError } from '../errors.js';
import type { ExecutionRepository } from './ExecutionRepository.js';
import type {
    ActorSummary,
    AttentionItem,
    AttentionKind,
    AttentionSeverity,
    AttentionState,
    AuthenticatedActor,
    IncidentEvent,
    Job,
    PageResponse
} from '../types/index.js';

interface AttentionRow {
    id: string;
    kind: AttentionKind;
    source_id: string;
    execution_id: string;
    job_id: string;
    reason: string;
    detail_snapshot: Record<string, unknown>;
    occurred_at: Date;
    state: AttentionState;
    state_changed_by_type: 'user' | 'api_token' | 'system' | null;
    state_changed_by_user_id: string | null;
    state_changed_by_label: string | null;
    state_changed_at: Date | null;
    resolution_action: 'rerun' | 'webhook_retry' | 'manual' | null;
    resolution_details: Record<string, unknown> | null;
    severity: AttentionSeverity;
    assignee_user_id: string | null;
    snoozed_until: Date | null;
    resolution_note: string | null;
    fingerprint: string;
    occurrence_count: number;
    last_occurred_at: Date;
    created_at: Date;
    updated_at: Date;
}

export interface AttentionListOptions {
    page: number;
    limit: 25 | 50 | 100;
    state: AttentionState;
    kind?: AttentionKind;
    search?: string;
    from?: Date;
    toExclusive?: Date;
}

export interface ExecutionFailureAttentionInput {
    executionId: string;
    jobId: string;
    reason: string;
    occurredAt: Date;
    detailSnapshot: Record<string, unknown>;
}

export interface WebhookFailureAttentionInput {
    deliveryId: string;
    executionId: string;
    jobId: string;
    reason: string;
    occurredAt: Date;
    detailSnapshot: Record<string, unknown>;
}

export class AttentionRepository {
    constructor(private readonly pool: DatabasePool) {}

    async list(options: AttentionListOptions): Promise<PageResponse<AttentionItem>> {
        await this.expireSnoozes();
        const query = buildListQuery(options);
        const [count, result] = await Promise.all([
            this.pool.query<{ count: string }>(
                `SELECT count(*)::text AS count FROM operational_attention_items ${query.where}`,
                query.parameters
            ),
            this.pool.query<AttentionRow>(
                `SELECT * FROM operational_attention_items ${query.where}
                 ORDER BY last_occurred_at DESC, id DESC
                 LIMIT $${query.parameters.length + 1} OFFSET $${query.parameters.length + 2}`,
                [...query.parameters, options.limit, (options.page - 1) * options.limit]
            )
        ]);
        const total = Number(count.rows[0]?.count ?? 0);
        return {
            items: result.rows.map(mapAttention),
            page: options.page,
            pageSize: options.limit,
            total,
            totalPages: Math.ceil(total / options.limit)
        };
    }

    async getById(attentionId: string): Promise<AttentionItem | undefined> {
        await this.expireSnoozes();
        const result = await this.pool.query<AttentionRow>(
            'SELECT * FROM operational_attention_items WHERE id = $1',
            [attentionId]
        );
        return result.rows[0] === undefined ? undefined : mapAttention(result.rows[0]);
    }

    async ignore(attentionId: string, actor: AuthenticatedActor): Promise<AttentionItem> {
        return this.changeState(attentionId, 'ignored', actor);
    }

    async restore(attentionId: string, actor: AuthenticatedActor): Promise<AttentionItem> {
        return this.changeState(attentionId, 'open', actor);
    }

    async acknowledge(attentionId: string, actor: AuthenticatedActor): Promise<AttentionItem> {
        return this.changeState(attentionId, 'acknowledged', actor);
    }

    async snooze(attentionId: string, until: Date, actor: AuthenticatedActor): Promise<AttentionItem> {
        if (until <= new Date()) throw new AppError('INVALID_SNOOZE_UNTIL', 'Snooze time must be in the future.', 422);
        return withTransaction(this.pool, async client => {
            const item = await lockAttention(client, attentionId);
            if (item.state === 'resolved') throw new AppError('ATTENTION_ALREADY_RESOLVED', 'Resolved incidents cannot be snoozed.', 409);
            const result = await client.query<AttentionRow>(
                `UPDATE operational_attention_items SET state = 'snoozed', snoozed_until = $2,
                    state_changed_by_type = $3, state_changed_by_user_id = $4, state_changed_by_label = $5,
                    state_changed_at = clock_timestamp(), resolution_action = NULL, resolution_details = NULL,
                    updated_at = clock_timestamp() WHERE id = $1 RETURNING *`,
                [attentionId, until, actorType(actor), actor.userId, actor.email]
            );
            await appendIncidentEvent(client, result.rows[0]!, 'snoozed', actor, { until: until.toISOString() });
            return mapAttention(result.rows[0]!);
        });
    }

    async assign(attentionId: string, userId: string | null, actor: AuthenticatedActor): Promise<AttentionItem> {
        return withTransaction(this.pool, async client => {
            const item = await lockAttention(client, attentionId);
            if (userId !== null) {
                const user = await client.query('SELECT 1 FROM security_users WHERE id = $1 AND status = \'active\'', [userId]);
                if (user.rows[0] === undefined) throw new AppError('ASSIGNEE_NOT_FOUND', 'Assignee must be an active user.', 422);
            }
            const result = await client.query<AttentionRow>(
                `UPDATE operational_attention_items SET assignee_user_id = $2, updated_at = clock_timestamp()
                 WHERE id = $1 RETURNING *`, [attentionId, userId]
            );
            await appendIncidentEvent(client, result.rows[0]!, 'assigned', actor, { previousUserId: item.assignee_user_id, userId });
            return mapAttention(result.rows[0]!);
        });
    }

    async setSeverity(attentionId: string, severity: AttentionSeverity, actor: AuthenticatedActor): Promise<AttentionItem> {
        return withTransaction(this.pool, async client => {
            const item = await lockAttention(client, attentionId);
            const result = await client.query<AttentionRow>(
                `UPDATE operational_attention_items SET severity = $2, updated_at = clock_timestamp()
                 WHERE id = $1 RETURNING *`, [attentionId, severity]
            );
            const increased = severityRank(severity) > severityRank(item.severity);
            await appendIncidentEvent(client, result.rows[0]!, increased ? 'severity_increased' : 'severity_changed', actor,
                { previousSeverity: item.severity, severity });
            return mapAttention(result.rows[0]!);
        });
    }

    async resolve(attentionId: string, note: string, actor: AuthenticatedActor): Promise<AttentionItem> {
        return withTransaction(this.pool, async client => {
            const item = await lockAttention(client, attentionId);
            if (item.state === 'resolved') return mapAttention(item);
            const result = await client.query<AttentionRow>(
                `UPDATE operational_attention_items SET state = 'resolved', resolution_action = 'manual',
                    resolution_details = jsonb_build_object('note', $2::text), resolution_note = $2,
                    snoozed_until = NULL, state_changed_by_type = $3, state_changed_by_user_id = $4,
                    state_changed_by_label = $5, state_changed_at = clock_timestamp(), updated_at = clock_timestamp()
                 WHERE id = $1 RETURNING *`, [attentionId, note, actorType(actor), actor.userId, actor.email]
            );
            await appendIncidentEvent(client, result.rows[0]!, 'resolved', actor, { note });
            return mapAttention(result.rows[0]!);
        });
    }

    async events(attentionId: string): Promise<IncidentEvent[]> {
        if (await this.getById(attentionId) === undefined) throw new AppError('ATTENTION_NOT_FOUND', `Attention item ${attentionId} was not found.`, 404);
        const result = await this.pool.query<{ id: string; attention_id: string; event_type: string; actor_type: ActorSummary['type']; actor_user_id: string | null; actor_label: string; details: Record<string, unknown>; created_at: Date }>(
            'SELECT * FROM incident_events WHERE attention_id = $1 ORDER BY id', [attentionId]
        );
        return result.rows.map(row => ({ eventId: row.id, attentionId: row.attention_id, eventType: row.event_type,
            actor: { type: row.actor_type, userId: row.actor_user_id, label: row.actor_label }, details: row.details,
            createdAt: row.created_at.toISOString() }));
    }

    async rerun(
        attentionId: string,
        executions: ExecutionRepository,
        actor: AuthenticatedActor
    ): Promise<AttentionItem> {
        return withTransaction(this.pool, async client => {
                const item = await lockAttention(client, attentionId);
                assertRemediable(item, 'execution_failure', 'rerun');
                const source = await client.query<{ input: Record<string, unknown> }>(
                    'SELECT input FROM executions WHERE id = $1',
                    [item.source_id]
                );
                if (source.rows[0] === undefined) {
                    throw new AppError(
                        'ATTENTION_SOURCE_NOT_FOUND',
                        `Source execution ${item.source_id} was not found.`,
                        404
                    );
                }
                const currentJob = await client.query<{ definition: Job }>(
                    'SELECT definition FROM jobs WHERE id = $1 FOR UPDATE',
                    [item.job_id]
                );
                if (currentJob.rows[0] === undefined) {
                    throw new AppError(
                        'ATTENTION_JOB_MISSING',
                        `Job ${item.job_id} no longer exists, so the execution cannot be rerun.`,
                        409
                    );
                }
                const newExecutionId = await executions.enqueueManualWithClient(
                    client,
                    currentJob.rows[0].definition,
                    source.rows[0].input,
                    actor
                );
                return updateResolved(client, item.id, actor, 'rerun', {
                    originalExecutionId: item.source_id,
                    newExecutionId
                });
        });
    }

    async retryWebhook(attentionId: string, actor: AuthenticatedActor): Promise<AttentionItem> {
        return withTransaction(this.pool, async client => {
            const item = await lockAttention(client, attentionId);
            assertRemediable(item, 'webhook_failure', 'retry webhook');
            const delivery = await client.query<{ attempt_count: number; status: string }>(
                'SELECT attempt_count, status FROM webhook_deliveries WHERE id = $1 FOR UPDATE',
                [item.source_id]
            );
            const source = delivery.rows[0];
            if (source === undefined) {
                throw new AppError(
                    'ATTENTION_SOURCE_NOT_FOUND',
                    `Webhook delivery ${item.source_id} was not found.`,
                    404
                );
            }
            if (source.status !== 'failed') {
                throw new AppError(
                    'ATTENTION_WEBHOOK_NOT_FAILED',
                    `Webhook delivery ${item.source_id} is ${source.status} and cannot be retried.`,
                    409
                );
            }
            const timestamp = (await client.query<{ now: Date }>(
                `UPDATE webhook_deliveries
                 SET status = 'pending', next_attempt_at = clock_timestamp(),
                     response_status = NULL, delivered_at = NULL, updated_at = clock_timestamp()
                 WHERE id = $1
                 RETURNING updated_at AS now`,
                [item.source_id]
            )).rows[0]!.now;
            return updateResolved(client, item.id, actor, 'webhook_retry', {
                deliveryId: item.source_id,
                attemptCountBeforeRetry: source.attempt_count,
                requeuedAt: timestamp.toISOString()
            });
        });
    }

    async openOverview(): Promise<{
        executionCount: number;
        webhookCount: number;
        failedExecutions: AttentionItem[];
        failedWebhooks: AttentionItem[];
    }> {
        const [counts, executionItems, webhookItems] = await Promise.all([
            this.pool.query<{ kind: AttentionKind; count: string }>(
                `SELECT kind, count(*)::text AS count
                FROM operational_attention_items WHERE state IN ('open', 'acknowledged') GROUP BY kind`
            ),
            this.pool.query<AttentionRow>(
                `SELECT * FROM operational_attention_items
                 WHERE state IN ('open', 'acknowledged') AND kind = 'execution_failure'
                 ORDER BY last_occurred_at DESC, id DESC LIMIT 5`
            ),
            this.pool.query<AttentionRow>(
                `SELECT * FROM operational_attention_items
                 WHERE state IN ('open', 'acknowledged') AND kind = 'webhook_failure'
                 ORDER BY last_occurred_at DESC, id DESC LIMIT 5`
            )
        ]);
        const byKind = Object.fromEntries(counts.rows.map(row => [row.kind, Number(row.count)]));
        return {
            executionCount: byKind.execution_failure ?? 0,
            webhookCount: byKind.webhook_failure ?? 0,
            failedExecutions: executionItems.rows.map(mapAttention),
            failedWebhooks: webhookItems.rows.map(mapAttention)
        };
    }

    private async changeState(
        attentionId: string,
        target: 'open' | 'acknowledged' | 'ignored',
        actor: AuthenticatedActor
    ): Promise<AttentionItem> {
        return withTransaction(this.pool, async client => {
            const item = await lockAttention(client, attentionId);
            if (item.state === 'resolved') {
                throw new AppError(
                    'ATTENTION_ALREADY_RESOLVED',
                    'Resolved attention items cannot be ignored or restored.',
                    409
                );
            }
            if (item.state === target) return mapAttention(item);
            const result = await client.query<AttentionRow>(
                `UPDATE operational_attention_items
                 SET state = $2, state_changed_by_type = $3,
                     state_changed_by_user_id = $4, state_changed_by_label = $5,
                     state_changed_at = clock_timestamp(), resolution_action = NULL,
                     resolution_details = NULL, resolution_note = NULL, snoozed_until = NULL,
                     updated_at = clock_timestamp()
                 WHERE id = $1 RETURNING *`,
                [attentionId, target, actorType(actor), actor.userId, actor.email]
            );
            await appendIncidentEvent(client, result.rows[0]!, target === 'open' ? 'restored' : target, actor, { previousState: item.state });
            return mapAttention(result.rows[0]!);
        });
    }

    private async expireSnoozes(): Promise<void> {
        await withTransaction(this.pool, async client => {
            const due = await client.query<AttentionRow>(
                `UPDATE operational_attention_items SET state = 'open', snoozed_until = NULL,
                    state_changed_by_type = 'system', state_changed_by_user_id = NULL,
                    state_changed_by_label = 'system', state_changed_at = clock_timestamp(), updated_at = clock_timestamp()
                 WHERE state = 'snoozed' AND snoozed_until <= clock_timestamp() RETURNING *`
            );
            for (const item of due.rows) await appendIncidentEvent(client, item, 'reopened', undefined, { reason: 'snooze_expired' });
        });
    }
}

export async function recordExecutionFailureAttention(
    client: DatabaseClient,
    input: ExecutionFailureAttentionInput
): Promise<void> {
    await upsertFailure(client, {
        kind: 'execution_failure',
        sourceId: input.executionId,
        executionId: input.executionId,
        jobId: input.jobId,
        reason: input.reason,
        occurredAt: input.occurredAt,
        detailSnapshot: input.detailSnapshot
    });
}

export async function recordWebhookFailureAttention(
    client: DatabaseClient,
    input: WebhookFailureAttentionInput
): Promise<void> {
    await upsertFailure(client, {
        kind: 'webhook_failure',
        sourceId: input.deliveryId,
        executionId: input.executionId,
        jobId: input.jobId,
        reason: input.reason,
        occurredAt: input.occurredAt,
        detailSnapshot: input.detailSnapshot
    });
}

async function upsertFailure(
    client: DatabaseClient,
    input: {
        kind: AttentionKind;
        sourceId: string;
        executionId: string;
        jobId: string;
        reason: string;
        occurredAt: Date;
        detailSnapshot: Record<string, unknown>;
    }
): Promise<void> {
    const fingerprint = failureFingerprint(input.kind, input.jobId, input.detailSnapshot);
    const severity: AttentionSeverity = input.kind === 'execution_failure' ? 'high' : 'medium';
    const existing = await client.query<AttentionRow>(
        `SELECT * FROM operational_attention_items
         WHERE fingerprint = $1 OR (kind = $2 AND source_id = $3)
         ORDER BY (fingerprint = $1) DESC LIMIT 1 FOR UPDATE`, [fingerprint, input.kind, input.sourceId]
    );
    if (existing.rows[0] === undefined) {
        const inserted = await client.query<AttentionRow>(
            `INSERT INTO operational_attention_items(
                id, kind, source_id, execution_id, job_id, reason, detail_snapshot, occurred_at,
                last_occurred_at, fingerprint, severity
             ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $8, $9, $10) RETURNING *`,
            [randomUUID(), input.kind, input.sourceId, input.executionId, input.jobId,
                input.reason, JSON.stringify(input.detailSnapshot), input.occurredAt, fingerprint, severity]
        );
        await appendIncidentEvent(client, inserted.rows[0]!, 'opened', undefined, { sourceId: input.sourceId });
        return;
    }
    const previous = existing.rows[0];
    const reopen = previous.state === 'resolved' || previous.state === 'ignored';
    const updated = await client.query<AttentionRow>(
        `UPDATE operational_attention_items SET source_id = $2, execution_id = $3, job_id = $4,
            reason = $5, detail_snapshot = $6::jsonb, occurred_at = $7, last_occurred_at = $7, fingerprint = $9,
            occurrence_count = occurrence_count + 1,
            state = CASE WHEN $8 THEN 'open' ELSE state END,
            state_changed_by_type = CASE WHEN $8 THEN 'system' ELSE state_changed_by_type END,
            state_changed_by_user_id = CASE WHEN $8 THEN NULL ELSE state_changed_by_user_id END,
            state_changed_by_label = CASE WHEN $8 THEN 'system' ELSE state_changed_by_label END,
            state_changed_at = CASE WHEN $8 THEN clock_timestamp() ELSE state_changed_at END,
            resolution_action = CASE WHEN $8 THEN NULL ELSE resolution_action END,
            resolution_details = CASE WHEN $8 THEN NULL ELSE resolution_details END,
            resolution_note = CASE WHEN $8 THEN NULL ELSE resolution_note END,
            snoozed_until = CASE WHEN $8 THEN NULL ELSE snoozed_until END,
            updated_at = clock_timestamp() WHERE id = $1 RETURNING *`,
        [previous.id, input.sourceId, input.executionId, input.jobId, input.reason,
            JSON.stringify(input.detailSnapshot), input.occurredAt, reopen, fingerprint]
    );
    await appendIncidentEvent(client, updated.rows[0]!, reopen ? 'reopened' : 'occurrence', undefined,
        { sourceId: input.sourceId, occurrenceCount: updated.rows[0]!.occurrence_count });
}

async function lockAttention(client: DatabaseClient, attentionId: string): Promise<AttentionRow> {
    const result = await client.query<AttentionRow>(
        'SELECT * FROM operational_attention_items WHERE id = $1 FOR UPDATE',
        [attentionId]
    );
    if (result.rows[0] === undefined) {
        throw new AppError('ATTENTION_NOT_FOUND', `Attention item ${attentionId} was not found.`, 404);
    }
    return result.rows[0];
}

function assertRemediable(item: AttentionRow, kind: AttentionKind, action: string): void {
    if (item.kind !== kind) {
        throw new AppError(
            'ATTENTION_KIND_CONFLICT',
            `This ${item.kind} item does not support ${action}.`,
            409
        );
    }
    if (item.state !== 'open' && item.state !== 'acknowledged') {
        throw new AppError(
            'ATTENTION_STATE_CONFLICT',
            `Only open attention items can ${action}.`,
            409
        );
    }
}

async function updateResolved(
    client: DatabaseClient,
    attentionId: string,
    actor: AuthenticatedActor,
    action: 'rerun' | 'webhook_retry',
    details: Record<string, unknown>
): Promise<AttentionItem> {
    const result = await client.query<AttentionRow>(
        `UPDATE operational_attention_items
         SET state = 'resolved', state_changed_by_type = $2,
             state_changed_by_user_id = $3, state_changed_by_label = $4,
             state_changed_at = clock_timestamp(), resolution_action = $5,
             resolution_details = $6::jsonb, updated_at = clock_timestamp()
         WHERE id = $1 RETURNING *`,
        [attentionId, actorType(actor), actor.userId, actor.email, action, JSON.stringify(details)]
    );
    await appendIncidentEvent(client, result.rows[0]!, 'resolved', actor, { action, ...details });
    return mapAttention(result.rows[0]!);
}

function actorType(actor: AuthenticatedActor): 'user' | 'api_token' {
    return actor.authType === 'session' ? 'user' : 'api_token';
}

function buildListQuery(options: AttentionListOptions): { where: string; parameters: unknown[] } {
    const parameters: unknown[] = [options.state];
    const predicates = ['state = $1'];
    const add = (predicate: (index: number) => string, value: unknown) => {
        parameters.push(value);
        predicates.push(predicate(parameters.length));
    };
    if (options.kind !== undefined) add(index => `kind = $${index}`, options.kind);
    if (options.search !== undefined) {
        add(
            index => `strpos(lower(job_id || ' ' || execution_id::text || ' ' || source_id::text || ' ' || reason), lower($${index})) > 0`,
            options.search
        );
    }
    if (options.from !== undefined) add(index => `occurred_at >= $${index}`, options.from);
    if (options.toExclusive !== undefined) add(index => `occurred_at < $${index}`, options.toExclusive);
    return { where: `WHERE ${predicates.join(' AND ')}`, parameters };
}

function mapAttention(row: AttentionRow): AttentionItem {
    const changedBy: ActorSummary | null = row.state_changed_by_type === null || row.state_changed_by_label === null
        ? null
        : {
            type: row.state_changed_by_type,
            userId: row.state_changed_by_user_id,
            label: row.state_changed_by_label
        };
    return {
        attentionId: row.id,
        kind: row.kind,
        sourceId: row.source_id,
        executionId: row.execution_id,
        jobId: row.job_id,
        reason: row.reason,
        detailSnapshot: row.detail_snapshot,
        occurredAt: row.occurred_at.toISOString(),
        lastOccurredAt: row.last_occurred_at.toISOString(),
        fingerprint: row.fingerprint,
        occurrenceCount: row.occurrence_count,
        severity: row.severity,
        assigneeUserId: row.assignee_user_id,
        snoozedUntil: row.snoozed_until?.toISOString() ?? null,
        resolutionNote: row.resolution_note,
        state: row.state,
        stateChangedBy: changedBy,
        stateChangedAt: row.state_changed_at?.toISOString() ?? null,
        resolutionAction: row.resolution_action,
        resolutionDetails: row.resolution_details,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString()
    };
}

export function failureFingerprint(
    kind: AttentionKind,
    jobId: string,
    details: Record<string, unknown>
): string {
    if (kind === 'execution_failure') {
        const code = typeof details.errorCode === 'string' && details.errorCode.length > 0 ? details.errorCode : 'UNKNOWN';
        return sha256(`execution_failure:${jobId}:${code}`);
    }
    const destination = typeof details.url === 'string' ? sha256(details.url) : 'unknown_destination';
    const responseStatus = typeof details.responseStatus === 'number' ? details.responseStatus : null;
    const error = typeof details.lastError === 'string' ? details.lastError.toLowerCase() : '';
    const category = responseStatus !== null ? `http_${Math.floor(responseStatus / 100)}xx`
        : error.includes('timeout') || error.includes('aborted') ? 'timeout'
            : error.includes('dns') || error.includes('enotfound') ? 'dns'
                : error.includes('network') || error.includes('connect') ? 'network'
                    : 'delivery_error';
    return sha256(`webhook_failure:${jobId}:${destination}:${category}`);
}

async function appendIncidentEvent(
    client: DatabaseClient,
    incident: AttentionRow,
    eventType: string,
    actor: AuthenticatedActor | undefined,
    details: Record<string, unknown>
): Promise<void> {
    const inserted = await client.query<{ id: string }>(
        `INSERT INTO incident_events(attention_id, event_type, actor_type, actor_user_id, actor_label, details)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb) RETURNING id`,
        [incident.id, eventType, actor === undefined ? 'system' : actorType(actor), actor?.userId ?? null,
            actor?.email ?? 'system', JSON.stringify(details)]
    );
    if (!['opened', 'reopened', 'severity_increased', 'resolved'].includes(eventType)) return;
    const policies = await client.query<{ id: string; channel_id: string }>(
        `SELECT p.id, p.channel_id FROM notification_policies p
         JOIN notification_channels c ON c.id = p.channel_id
         WHERE p.enabled AND c.enabled AND $1 = ANY(p.lifecycle_events) AND $2 = ANY(p.incident_kinds)
           AND (p.job_ids IS NULL OR $3 = ANY(p.job_ids))
           AND (CASE $4 WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END) >=
               (CASE p.minimum_severity WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END)`,
        [eventType, incident.kind, incident.job_id, incident.severity]
    );
    const payload = {
        event: `incident.${eventType}`,
        incident: {
            attentionId: incident.id, kind: incident.kind, severity: incident.severity,
            state: incident.state, jobId: incident.job_id, executionId: incident.execution_id,
            reason: incident.reason, occurrenceCount: incident.occurrence_count,
            lastOccurredAt: incident.last_occurred_at.toISOString()
        }
    };
    for (const policy of policies.rows) {
        await client.query(
            `INSERT INTO notification_deliveries(id, incident_event_id, channel_id, policy_id, payload)
             VALUES ($1, $2, $3, $4, $5::jsonb) ON CONFLICT DO NOTHING`,
            [randomUUID(), inserted.rows[0]!.id, policy.channel_id, policy.id, JSON.stringify(payload)]
        );
    }
}

function severityRank(value: AttentionSeverity): number {
    return { low: 1, medium: 2, high: 3, critical: 4 }[value];
}

function sha256(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}
