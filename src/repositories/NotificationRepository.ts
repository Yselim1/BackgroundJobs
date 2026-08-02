import { randomUUID } from 'node:crypto';
import type { DatabasePool } from '../db/pool.js';
import { withTransaction } from '../db/pool.js';
import { AppError } from '../errors.js';
import type { AuthenticatedActor, NotificationChannel, NotificationChannelKind, NotificationDelivery, NotificationPolicy } from '../types/index.js';

interface ChannelRow { id: string; name: string; kind: NotificationChannelKind; endpoint_secret_name: string; signing_secret_name: string | null; enabled: boolean; version: number; created_at: Date; updated_at: Date; }
interface PolicyRow { id: string; name: string; channel_id: string; enabled: boolean; incident_kinds: NotificationPolicy['incidentKinds']; minimum_severity: NotificationPolicy['minimumSeverity']; job_ids: string[] | null; lifecycle_events: NotificationPolicy['lifecycleEvents']; version: number; created_at: Date; updated_at: Date; }
interface DeliveryRow { id: string; incident_event_id: string; channel_id: string; policy_id: string; payload: Record<string, unknown>; status: NotificationDelivery['status']; attempt_count: number; next_attempt_at: Date; response_status: number | null; last_error: string | null; created_at: Date; updated_at: Date; delivered_at: Date | null; kind: NotificationChannelKind; endpoint_secret_name: string; signing_secret_name: string | null; }

export interface ClaimedNotificationDelivery {
    deliveryId: string;
    payload: Record<string, unknown>;
    attemptCount: number;
    kind: NotificationChannelKind;
    endpointSecretName: string;
    signingSecretName: string | null;
}

export class NotificationRepository {
    constructor(private readonly pool: DatabasePool) {}

    async listChannels(): Promise<NotificationChannel[]> {
        const result = await this.pool.query<ChannelRow>('SELECT * FROM notification_channels ORDER BY name, id');
        return result.rows.map(mapChannel);
    }

    async createChannel(input: { name: string; kind: NotificationChannelKind; endpointSecretName: string; signingSecretName: string | null; enabled: boolean }, actor: AuthenticatedActor): Promise<NotificationChannel> {
        await this.assertSecrets(input.endpointSecretName, input.signingSecretName);
        const result = await this.pool.query<ChannelRow>(
            `INSERT INTO notification_channels(id, name, kind, endpoint_secret_name, signing_secret_name, enabled, created_by_user_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
            [randomUUID(), input.name, input.kind, input.endpointSecretName, input.signingSecretName, input.enabled, actor.userId]
        );
        return mapChannel(result.rows[0]!);
    }

    async updateChannel(id: string, input: Partial<{ name: string; endpointSecretName: string; signingSecretName: string | null; enabled: boolean }>, expectedVersion: number): Promise<NotificationChannel> {
        return withTransaction(this.pool, async client => {
            const current = await client.query<ChannelRow>('SELECT * FROM notification_channels WHERE id = $1 FOR UPDATE', [id]);
            const row = current.rows[0];
            if (row === undefined) throw new AppError('NOTIFICATION_CHANNEL_NOT_FOUND', `Notification channel ${id} was not found.`, 404);
            if (row.version !== expectedVersion) throw new AppError('NOTIFICATION_VERSION_CONFLICT', 'Notification channel version changed.', 409, { currentVersion: row.version });
            const endpoint = input.endpointSecretName ?? row.endpoint_secret_name;
            const signing = input.signingSecretName === undefined ? row.signing_secret_name : input.signingSecretName;
            if (row.kind === 'generic_webhook' && signing === null) {
                throw new AppError('INVALID_NOTIFICATION_CHANNEL', 'Generic webhooks require signingSecretName.', 422);
            }
            await this.assertSecrets(endpoint, signing);
            const result = await client.query<ChannelRow>(
                `UPDATE notification_channels SET name = $2, endpoint_secret_name = $3, signing_secret_name = $4,
                    enabled = $5, version = version + 1, updated_at = clock_timestamp() WHERE id = $1 RETURNING *`,
                [id, input.name ?? row.name, endpoint, signing, input.enabled ?? row.enabled]
            );
            return mapChannel(result.rows[0]!);
        });
    }

    async listPolicies(): Promise<NotificationPolicy[]> {
        const result = await this.pool.query<PolicyRow>('SELECT * FROM notification_policies ORDER BY name, id');
        return result.rows.map(mapPolicy);
    }

    async createPolicy(input: Omit<NotificationPolicy, 'policyId' | 'version' | 'createdAt' | 'updatedAt'>, actor: AuthenticatedActor): Promise<NotificationPolicy> {
        await this.assertChannel(input.channelId);
        const result = await this.pool.query<PolicyRow>(
            `INSERT INTO notification_policies(id, name, channel_id, enabled, incident_kinds, minimum_severity,
                job_ids, lifecycle_events, created_by_user_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
            [randomUUID(), input.name, input.channelId, input.enabled, input.incidentKinds, input.minimumSeverity,
                input.jobIds, input.lifecycleEvents, actor.userId]
        );
        return mapPolicy(result.rows[0]!);
    }

    async updatePolicy(id: string, input: Partial<Omit<NotificationPolicy, 'policyId' | 'version' | 'createdAt' | 'updatedAt'>>, expectedVersion: number): Promise<NotificationPolicy> {
        return withTransaction(this.pool, async client => {
            const current = await client.query<PolicyRow>('SELECT * FROM notification_policies WHERE id = $1 FOR UPDATE', [id]);
            const row = current.rows[0];
            if (row === undefined) throw new AppError('NOTIFICATION_POLICY_NOT_FOUND', `Notification policy ${id} was not found.`, 404);
            if (row.version !== expectedVersion) throw new AppError('NOTIFICATION_VERSION_CONFLICT', 'Notification policy version changed.', 409, { currentVersion: row.version });
            const channelId = input.channelId ?? row.channel_id;
            const channel = await client.query<{ id: string }>('SELECT id FROM notification_channels WHERE id = $1', [channelId]);
            if (channel.rows[0] === undefined) throw new AppError('NOTIFICATION_CHANNEL_NOT_FOUND', `Notification channel ${channelId} was not found.`, 404);
            const result = await client.query<PolicyRow>(
                `UPDATE notification_policies SET name = $2, channel_id = $3, enabled = $4,
                    incident_kinds = $5, minimum_severity = $6, job_ids = $7, lifecycle_events = $8,
                    version = version + 1, updated_at = clock_timestamp() WHERE id = $1 RETURNING *`,
                [id, input.name ?? row.name, channelId, input.enabled ?? row.enabled,
                    input.incidentKinds ?? row.incident_kinds, input.minimumSeverity ?? row.minimum_severity,
                    input.jobIds === undefined ? row.job_ids : input.jobIds, input.lifecycleEvents ?? row.lifecycle_events]
            );
            return mapPolicy(result.rows[0]!);
        });
    }

    async listDeliveries(limit = 100): Promise<NotificationDelivery[]> {
        const result = await this.pool.query<DeliveryRow>(
            `SELECT d.*, c.kind, c.endpoint_secret_name, c.signing_secret_name
             FROM notification_deliveries d JOIN notification_channels c ON c.id = d.channel_id
             ORDER BY d.created_at DESC LIMIT $1`, [limit]
        );
        return result.rows.map(mapDelivery);
    }

    async retry(deliveryId: string): Promise<NotificationDelivery> {
        const result = await this.pool.query<DeliveryRow>(
            `UPDATE notification_deliveries SET status = 'pending', next_attempt_at = clock_timestamp(),
                response_status = NULL, last_error = NULL, delivered_at = NULL, updated_at = clock_timestamp()
             WHERE id = $1 AND status = 'failed' RETURNING *`, [deliveryId]
        );
        if (result.rows[0] === undefined) throw new AppError('NOTIFICATION_NOT_RETRYABLE', 'Notification delivery was not found or is not failed.', 409);
        return mapDelivery(result.rows[0]);
    }

    async reconcileDelivering(maxAttempts: number): Promise<void> {
        await this.pool.query(
            `UPDATE notification_deliveries SET status = CASE WHEN attempt_count >= $1 THEN 'failed' ELSE 'pending' END,
                next_attempt_at = clock_timestamp(), last_error = 'Server stopped during notification delivery.',
                updated_at = clock_timestamp() WHERE status = 'delivering'`, [maxAttempts]
        );
    }

    async claimDue(): Promise<ClaimedNotificationDelivery | undefined> {
        return withTransaction(this.pool, async client => {
            const result = await client.query<DeliveryRow>(
                `WITH candidate AS (
                    SELECT d.id FROM notification_deliveries d JOIN notification_channels c ON c.id = d.channel_id
                    WHERE d.status = 'pending' AND d.next_attempt_at <= clock_timestamp() AND c.enabled
                    ORDER BY d.next_attempt_at, d.created_at FOR UPDATE OF d SKIP LOCKED LIMIT 1
                 )
                 UPDATE notification_deliveries d SET status = 'delivering', attempt_count = attempt_count + 1,
                    updated_at = clock_timestamp() FROM candidate, notification_channels c
                 WHERE d.id = candidate.id AND c.id = d.channel_id RETURNING d.*, c.kind, c.endpoint_secret_name, c.signing_secret_name`
            );
            const row = result.rows[0];
            return row === undefined ? undefined : { deliveryId: row.id, payload: row.payload, attemptCount: row.attempt_count,
                kind: row.kind, endpointSecretName: row.endpoint_secret_name, signingSecretName: row.signing_secret_name };
        });
    }

    async complete(id: string, responseStatus: number): Promise<void> {
        await this.pool.query(
            `UPDATE notification_deliveries SET status = 'success', response_status = $2, last_error = NULL,
                delivered_at = clock_timestamp(), updated_at = clock_timestamp() WHERE id = $1 AND status = 'delivering'`,
            [id, responseStatus]
        );
    }

    async fail(id: string, maxAttempts: number, error: string, responseStatus: number | null): Promise<void> {
        await this.pool.query(
            `UPDATE notification_deliveries SET
                status = CASE WHEN attempt_count >= $2 THEN 'failed' ELSE 'pending' END,
                response_status = $3, last_error = $4,
                next_attempt_at = CASE WHEN attempt_count >= $2 THEN next_attempt_at
                    ELSE clock_timestamp() + (least(3600000, 1000 * power(2, greatest(0, attempt_count - 1))) * interval '1 millisecond') END,
                updated_at = clock_timestamp() WHERE id = $1 AND status = 'delivering'`,
            [id, maxAttempts, responseStatus, error]
        );
    }

    private async assertSecrets(endpoint: string, signing: string | null): Promise<void> {
        const names = [endpoint, signing].filter((value): value is string => value !== null);
        const result = await this.pool.query<{ name: string }>('SELECT name FROM managed_secrets WHERE name = ANY($1::text[])', [names]);
        if (result.rows.length !== new Set(names).size) throw new AppError('NOTIFICATION_SECRET_NOT_FOUND', 'Every notification secret reference must exist.', 422);
    }

    private async assertChannel(channelId: string): Promise<void> {
        const result = await this.pool.query<{ id: string }>('SELECT id FROM notification_channels WHERE id = $1', [channelId]);
        if (result.rows[0] === undefined) throw new AppError('NOTIFICATION_CHANNEL_NOT_FOUND', `Notification channel ${channelId} was not found.`, 404);
    }
}

function mapChannel(row: ChannelRow): NotificationChannel { return { channelId: row.id, name: row.name, kind: row.kind,
    endpointSecretName: row.endpoint_secret_name, signingSecretName: row.signing_secret_name, enabled: row.enabled,
    version: row.version, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() }; }
function mapPolicy(row: PolicyRow): NotificationPolicy { return { policyId: row.id, name: row.name, channelId: row.channel_id,
    enabled: row.enabled, incidentKinds: row.incident_kinds, minimumSeverity: row.minimum_severity, jobIds: row.job_ids,
    lifecycleEvents: row.lifecycle_events, version: row.version, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() }; }
function mapDelivery(row: DeliveryRow): NotificationDelivery { return { deliveryId: row.id, incidentEventId: row.incident_event_id,
    channelId: row.channel_id, policyId: row.policy_id, status: row.status, attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at.toISOString(), responseStatus: row.response_status, lastError: row.last_error,
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(), deliveredAt: row.delivered_at?.toISOString() ?? null }; }
