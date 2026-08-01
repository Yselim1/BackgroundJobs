import type { DatabasePool } from '../db/pool.js';
import { withTransaction } from '../db/pool.js';
import { recordWebhookFailureAttention } from './AttentionRepository.js';

interface WebhookDeliveryRow {
    id: string;
    execution_id: string;
    event_type: string;
    url: string;
    payload: Record<string, unknown>;
    status: 'pending' | 'delivering' | 'success' | 'failed';
    attempt_count: number;
    next_attempt_at: Date;
    response_status: number | null;
    last_error: string | null;
    signing_secret_name: string | null;
    updated_at: Date;
}

export interface ClaimedWebhookDelivery {
    deliveryId: string;
    executionId: string;
    eventType: string;
    url: string;
    payload: Record<string, unknown>;
    attemptCount: number;
    signingSecretName: string | null;
}

export class WebhookRepository {
    constructor(private readonly pool: DatabasePool) {}

    async reconcileDelivering(maxAttempts: number): Promise<number> {
        return withTransaction(this.pool, async client => {
            const result = await client.query<WebhookDeliveryRow>(
                `UPDATE webhook_deliveries
                 SET status = CASE WHEN attempt_count >= $1 THEN 'failed' ELSE 'pending' END,
                     next_attempt_at = clock_timestamp(),
                     last_error = 'Server stopped before the delivery result was persisted.',
                     updated_at = clock_timestamp()
                 WHERE status = 'delivering'
                 RETURNING *`,
                [maxAttempts]
            );
            for (const row of result.rows.filter(item => item.status === 'failed')) {
                const execution = await client.query<{ job_id: string }>(
                    'SELECT job_id FROM executions WHERE id = $1',
                    [row.execution_id]
                );
                if (execution.rows[0] !== undefined) {
                    await recordWebhookFailureAttention(client, {
                        deliveryId: row.id,
                        executionId: row.execution_id,
                        jobId: execution.rows[0].job_id,
                        reason: row.last_error ?? 'Webhook delivery failed without an error message.',
                        occurredAt: row.updated_at,
                        detailSnapshot: webhookFailureSnapshot(row)
                    });
                }
            }
            return result.rowCount ?? 0;
        });
    }

    async claimDue(now?: Date): Promise<ClaimedWebhookDelivery | undefined> {
        return withTransaction(this.pool, async client => {
            const candidate = await client.query<WebhookDeliveryRow>(
                `SELECT * FROM webhook_deliveries
                 WHERE status = 'pending'
                   AND next_attempt_at <= COALESCE($1::timestamptz, clock_timestamp())
                 ORDER BY next_attempt_at, created_at, id
                 FOR UPDATE SKIP LOCKED
                 LIMIT 1`,
                [now ?? null]
            );
            const row = candidate.rows[0];
            if (row === undefined) return undefined;
            const claimed = await client.query<WebhookDeliveryRow>(
                `UPDATE webhook_deliveries
                 SET status = 'delivering', attempt_count = attempt_count + 1,
                     updated_at = clock_timestamp()
                 WHERE id = $1 AND status = 'pending'
                 RETURNING *`,
                [row.id]
            );
            const updated = claimed.rows[0];
            if (updated === undefined) return undefined;
            return {
                deliveryId: updated.id,
                executionId: updated.execution_id,
                eventType: updated.event_type,
                url: updated.url,
                payload: updated.payload,
                attemptCount: updated.attempt_count,
                signingSecretName: updated.signing_secret_name
            };
        });
    }

    async complete(deliveryId: string, responseStatus: number): Promise<void> {
        await this.pool.query(
            `UPDATE webhook_deliveries
             SET status = 'success', response_status = $2, last_error = NULL,
                 delivered_at = clock_timestamp(), updated_at = clock_timestamp()
             WHERE id = $1 AND status = 'delivering'`,
            [deliveryId, responseStatus]
        );
    }

    async fail(
        deliveryId: string,
        maxAttempts: number,
        error: string,
        responseStatus: number | null
    ): Promise<'pending' | 'failed'> {
        return withTransaction(this.pool, async client => {
            const result = await client.query<WebhookDeliveryRow>(
                'SELECT * FROM webhook_deliveries WHERE id = $1 FOR UPDATE',
                [deliveryId]
            );
            const row = result.rows[0];
            if (row === undefined || row.status !== 'delivering') return 'failed';
            const exhausted = row.attempt_count >= maxAttempts;
            const retryDelayMs = Math.min(3_600_000, 1_000 * (2 ** Math.max(0, row.attempt_count - 1)));
            const updated = await client.query<WebhookDeliveryRow>(
                `UPDATE webhook_deliveries
                 SET status = $2, response_status = $3, last_error = $4,
                     next_attempt_at = CASE
                         WHEN $2 = 'pending' THEN clock_timestamp() + ($5 * interval '1 millisecond')
                         ELSE next_attempt_at
                     END,
                     updated_at = clock_timestamp()
                 WHERE id = $1
                 RETURNING *`,
                [deliveryId, exhausted ? 'failed' : 'pending', responseStatus, error, retryDelayMs]
            );
            const failedRow = updated.rows[0];
            if (exhausted && failedRow !== undefined) {
                const execution = await client.query<{ job_id: string }>(
                    'SELECT job_id FROM executions WHERE id = $1',
                    [failedRow.execution_id]
                );
                if (execution.rows[0] !== undefined) {
                    await recordWebhookFailureAttention(client, {
                        deliveryId: failedRow.id,
                        executionId: failedRow.execution_id,
                        jobId: execution.rows[0].job_id,
                        reason: failedRow.last_error ?? 'Webhook delivery failed without an error message.',
                        occurredAt: failedRow.updated_at,
                        detailSnapshot: webhookFailureSnapshot(failedRow)
                    });
                }
            }
            return exhausted ? 'failed' : 'pending';
        });
    }
}

function webhookFailureSnapshot(row: WebhookDeliveryRow): Record<string, unknown> {
    return {
        deliveryId: row.id,
        eventType: row.event_type,
        url: row.url,
        attemptCount: row.attempt_count,
        responseStatus: row.response_status,
        lastError: row.last_error
    };
}
