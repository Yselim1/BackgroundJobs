import type { DatabasePool } from '../db/pool.js';
import { AppError } from '../errors.js';
import type { AuditEvent, AuthenticatedActor } from '../types/index.js';

type AuditActorType = 'anonymous' | 'user' | 'api_token' | 'system';

interface AuditRow {
    id: string;
    request_id: string;
    actor_type: AuditActorType;
    actor_user_id: string | null;
    actor_label: string;
    action: string;
    outcome: 'success' | 'failure';
    status_code: number;
    resource_type: string | null;
    resource_id: string | null;
    ip_address: string | null;
    user_agent: string | null;
    metadata: Record<string, unknown>;
    created_at: Date;
}

export interface AuditRecordInput {
    requestId: string;
    actor?: AuthenticatedActor;
    actorType?: AuditActorType;
    actorLabel?: string;
    action: string;
    outcome: 'success' | 'failure';
    statusCode: number;
    resourceType?: string;
    resourceId?: string;
    ipAddress?: string | null;
    userAgent?: string | null;
    metadata?: Record<string, unknown>;
}

export interface AuditListOptions {
    limit: number;
    cursor?: string;
    action?: string;
    actorUserId?: string;
    outcome?: 'success' | 'failure';
}

export class AuditRepository {
    constructor(private readonly pool: DatabasePool) {}

    async record(input: AuditRecordInput): Promise<void> {
        const actorType = input.actor === undefined
            ? input.actorType ?? 'anonymous'
            : input.actor.authType === 'session' ? 'user' : 'api_token';
        const actorLabel = input.actor?.email ?? input.actorLabel ?? 'anonymous';
        await this.pool.query(
            `INSERT INTO security_audit_events(
                request_id, actor_type, actor_user_id, actor_label, action, outcome,
                status_code, resource_type, resource_id, ip_address, user_agent, metadata
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::inet, $11, $12::jsonb)`,
            [
                input.requestId,
                actorType,
                input.actor?.userId ?? null,
                actorLabel,
                input.action,
                input.outcome,
                input.statusCode,
                input.resourceType ?? null,
                input.resourceId ?? null,
                input.ipAddress ?? null,
                input.userAgent?.slice(0, 1_000) ?? null,
                JSON.stringify(input.metadata ?? {})
            ]
        );
    }

    async list(options: AuditListOptions): Promise<{ items: AuditEvent[]; nextCursor: string | null }> {
        const cursor = options.cursor === undefined ? undefined : decodeCursor(options.cursor);
        const result = await this.pool.query<AuditRow>(
            `SELECT * FROM security_audit_events
             WHERE ($1::bigint IS NULL OR id < $1)
               AND ($2::text IS NULL OR action = $2)
               AND ($3::uuid IS NULL OR actor_user_id = $3)
               AND ($4::text IS NULL OR outcome = $4)
             ORDER BY id DESC
             LIMIT $5`,
            [cursor ?? null, options.action ?? null, options.actorUserId ?? null, options.outcome ?? null, options.limit + 1]
        );
        const hasMore = result.rows.length > options.limit;
        const rows = result.rows.slice(0, options.limit);
        return {
            items: rows.map(mapAudit),
            nextCursor: hasMore && rows.length > 0 ? encodeCursor(rows.at(-1)!.id) : null
        };
    }
}

function mapAudit(row: AuditRow): AuditEvent {
    return {
        auditId: row.id,
        requestId: row.request_id,
        actorType: row.actor_type,
        actorUserId: row.actor_user_id,
        actorLabel: row.actor_label,
        action: row.action,
        outcome: row.outcome,
        statusCode: row.status_code,
        resourceType: row.resource_type,
        resourceId: row.resource_id,
        ipAddress: row.ip_address,
        userAgent: row.user_agent,
        metadata: row.metadata,
        createdAt: row.created_at.toISOString()
    };
}

function encodeCursor(id: string): string {
    return Buffer.from(id, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): string {
    try {
        const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
        if (!/^\d+$/u.test(decoded)) throw new Error('Invalid cursor payload.');
        return decoded;
    } catch {
        throw new AppError('INVALID_AUDIT_CURSOR', 'cursor is invalid.', 400);
    }
}
