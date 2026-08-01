import { randomUUID } from 'node:crypto';
import type { DatabaseClient, DatabasePool } from '../db/pool.js';
import { isUniqueViolation, withTransaction } from '../db/pool.js';
import { AppError } from '../errors.js';
import type { ExecutionRepository } from './ExecutionRepository.js';
import type {
    ActorSummary,
    AttentionItem,
    AttentionKind,
    AttentionState,
    AuthenticatedActor,
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
    resolution_action: 'rerun' | 'webhook_retry' | null;
    resolution_details: Record<string, unknown> | null;
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
        const query = buildListQuery(options);
        const [count, result] = await Promise.all([
            this.pool.query<{ count: string }>(
                `SELECT count(*)::text AS count FROM operational_attention_items ${query.where}`,
                query.parameters
            ),
            this.pool.query<AttentionRow>(
                `SELECT * FROM operational_attention_items ${query.where}
                 ORDER BY occurred_at DESC, id DESC
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

    async rerun(
        attentionId: string,
        executions: ExecutionRepository,
        actor: AuthenticatedActor
    ): Promise<AttentionItem> {
        try {
            return await withTransaction(this.pool, async client => {
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
        } catch (error: unknown) {
            if (isUniqueViolation(error, 'executions_one_active_per_job_uidx')) {
                throw new AppError(
                    'ATTENTION_JOB_ACTIVE',
                    'The job already has a queued or running execution.',
                    409
                );
            }
            throw error;
        }
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
                 FROM operational_attention_items WHERE state = 'open' GROUP BY kind`
            ),
            this.pool.query<AttentionRow>(
                `SELECT * FROM operational_attention_items
                 WHERE state = 'open' AND kind = 'execution_failure'
                 ORDER BY occurred_at DESC, id DESC LIMIT 5`
            ),
            this.pool.query<AttentionRow>(
                `SELECT * FROM operational_attention_items
                 WHERE state = 'open' AND kind = 'webhook_failure'
                 ORDER BY occurred_at DESC, id DESC LIMIT 5`
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
        target: 'open' | 'ignored',
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
                     resolution_details = NULL, updated_at = clock_timestamp()
                 WHERE id = $1 RETURNING *`,
                [attentionId, target, actorType(actor), actor.userId, actor.email]
            );
            return mapAttention(result.rows[0]!);
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
    await client.query(
        `INSERT INTO operational_attention_items(
            id, kind, source_id, execution_id, job_id, reason, detail_snapshot, occurred_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
         ON CONFLICT (kind, source_id) DO UPDATE
         SET execution_id = EXCLUDED.execution_id, job_id = EXCLUDED.job_id,
             reason = EXCLUDED.reason, detail_snapshot = EXCLUDED.detail_snapshot,
             occurred_at = EXCLUDED.occurred_at, state = 'open',
             state_changed_by_type = 'system', state_changed_by_user_id = NULL,
             state_changed_by_label = 'system', state_changed_at = clock_timestamp(),
             resolution_action = NULL, resolution_details = NULL,
             updated_at = clock_timestamp()`,
        [
            randomUUID(), input.kind, input.sourceId, input.executionId, input.jobId,
            input.reason, JSON.stringify(input.detailSnapshot), input.occurredAt
        ]
    );
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
    if (item.state !== 'open') {
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
        state: row.state,
        stateChangedBy: changedBy,
        stateChangedAt: row.state_changed_at?.toISOString() ?? null,
        resolutionAction: row.resolution_action,
        resolutionDetails: row.resolution_details,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString()
    };
}
