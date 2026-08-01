import type { DatabasePool } from '../db/pool.js';
import { AppError } from '../errors.js';
import type { AuditEvent, AuthenticatedActor, PageResponse } from '../types/index.js';

export type AuditActorType = 'anonymous' | 'user' | 'api_token' | 'system';

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
    page?: number;
    action?: string;
    actorUserId?: string;
    actorType?: AuditActorType;
    actorLabel?: string;
    resource?: string;
    resourceType?: string;
    resourceId?: string;
    outcome?: 'success' | 'failure';
    from?: Date;
    to?: Date;
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

    async getById(auditId: string): Promise<AuditEvent | undefined> {
        const result = await this.pool.query<AuditRow>(
            'SELECT * FROM security_audit_events WHERE id = $1',
            [auditId]
        );
        return result.rows[0] === undefined ? undefined : mapAudit(result.rows[0]);
    }

    async list(options: AuditListOptions & { page: number }): Promise<PageResponse<AuditEvent>>;
    async list(options: AuditListOptions): Promise<{ items: AuditEvent[]; nextCursor: string | null }>;
    async list(options: AuditListOptions): Promise<PageResponse<AuditEvent> | { items: AuditEvent[]; nextCursor: string | null }> {
        const query = buildAuditQuery(options);
        if (options.page !== undefined) {
            const count = await this.pool.query<{ count: string }>(
                `SELECT count(*)::text AS count FROM security_audit_events ${query.where}`,
                query.parameters
            );
            const total = Number(count.rows[0]?.count ?? 0);
            const parameters = [
                ...query.parameters,
                options.limit,
                (options.page - 1) * options.limit
            ];
            const result = await this.pool.query<AuditRow>(
                `SELECT * FROM security_audit_events ${query.where}
                 ORDER BY created_at DESC, id DESC
                 LIMIT $${parameters.length - 1} OFFSET $${parameters.length}`,
                parameters
            );
            return {
                items: result.rows.map(mapAudit),
                page: options.page,
                pageSize: options.limit,
                total,
                totalPages: Math.ceil(total / options.limit)
            };
        }

        const cursor = options.cursor === undefined ? undefined : decodeCursor(options.cursor);
        const parameters = [...query.parameters];
        const predicates = [...query.predicates];
        if (cursor !== undefined) {
            parameters.push(cursor);
            predicates.push(`id < $${parameters.length}::bigint`);
        }
        parameters.push(options.limit + 1);
        const where = predicates.length === 0 ? '' : `WHERE ${predicates.join(' AND ')}`;
        const result = await this.pool.query<AuditRow>(
            `SELECT * FROM security_audit_events ${where}
             ORDER BY created_at DESC, id DESC
             LIMIT $${parameters.length}`,
            parameters
        );
        const hasMore = result.rows.length > options.limit;
        const rows = result.rows.slice(0, options.limit);
        return {
            items: rows.map(mapAudit),
            nextCursor: hasMore && rows.length > 0 ? encodeCursor(rows.at(-1)!.id) : null
        };
    }

    async listForExport(
        options: Omit<AuditListOptions, 'cursor' | 'page' | 'limit'>,
        limit = 10_000
    ): Promise<{ items: AuditEvent[]; total: number; truncated: boolean }> {
        const query = buildAuditQuery({ ...options, limit });
        const [count, result] = await Promise.all([
            this.pool.query<{ count: string }>(
                `SELECT count(*)::text AS count FROM security_audit_events ${query.where}`,
                query.parameters
            ),
            this.pool.query<AuditRow>(
                `SELECT * FROM security_audit_events ${query.where}
                 ORDER BY created_at DESC, id DESC
                 LIMIT $${query.parameters.length + 1}`,
                [...query.parameters, limit]
            )
        ]);
        const total = Number(count.rows[0]?.count ?? 0);
        return { items: result.rows.map(mapAudit), total, truncated: total > limit };
    }
}

function buildAuditQuery(options: AuditListOptions): { predicates: string[]; parameters: unknown[]; where: string } {
    const predicates: string[] = [];
    const parameters: unknown[] = [];
    const add = (predicate: (index: number) => string, value: unknown) => {
        parameters.push(value);
        predicates.push(predicate(parameters.length));
    };
    if (options.action !== undefined) {
        add(index => `strpos(lower(action), lower($${index})) > 0`, options.action);
    }
    if (options.actorUserId !== undefined) {
        add(index => `actor_user_id = $${index}::uuid`, options.actorUserId);
    }
    if (options.actorType !== undefined) {
        add(index => `actor_type = $${index}`, options.actorType);
    }
    if (options.actorLabel !== undefined) {
        add(index => `strpos(lower(actor_label), lower($${index})) > 0`, options.actorLabel);
    }
    if (options.resource !== undefined) {
        add(
            index => `strpos(lower(coalesce(resource_type, '') || ' ' || coalesce(resource_id, '')), lower($${index})) > 0`,
            options.resource
        );
    }
    if (options.resourceType !== undefined) {
        add(index => `resource_type = $${index}`, options.resourceType);
    }
    if (options.resourceId !== undefined) {
        add(index => `resource_id = $${index}`, options.resourceId);
    }
    if (options.outcome !== undefined) {
        add(index => `outcome = $${index}`, options.outcome);
    }
    if (options.from !== undefined) {
        add(index => `created_at >= $${index}`, options.from);
    }
    if (options.to !== undefined) {
        add(index => `created_at < $${index}`, options.to);
    }
    return {
        predicates,
        parameters,
        where: predicates.length === 0 ? '' : `WHERE ${predicates.join(' AND ')}`
    };
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
