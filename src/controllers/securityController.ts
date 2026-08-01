import { Router, type NextFunction, type Request, type Response } from 'express';
import type { AppConfig } from '../config.js';
import { getSchemaVersions } from '../db/migrations.js';
import type { DatabasePool } from '../db/pool.js';
import { AppError } from '../errors.js';
import { AuditRepository, type AuditActorType, type AuditListOptions } from '../repositories/AuditRepository.js';
import { requirePermission } from '../security/middleware.js';
import { AuthService } from '../services/AuthService.js';
import { SecretService } from '../services/SecretService.js';
import type { JobExecutionManager } from '../services/JobExecutionManager.js';
import type { WebhookDispatcher } from '../services/WebhookDispatcher.js';
import type { AuditEvent } from '../types/index.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;
const AUDIT_ACTOR_TYPES = new Set<AuditActorType>(['anonymous', 'user', 'api_token', 'system']);
const AUDIT_EXPORT_LIMIT = 10_000;

export interface SecurityControllerRuntime {
    pool: DatabasePool;
    config: AppConfig;
    manager: JobExecutionManager;
    webhookDispatcher: WebhookDispatcher | undefined;
}

export function createSecurityController(
    auth: AuthService,
    secrets: SecretService,
    audit: AuditRepository,
    runtime: SecurityControllerRuntime
): Router {
    const router = Router();
    router.use((_req, res, next) => {
        res.setHeader('Cache-Control', 'no-store');
        next();
    });

    router.get('/users', requirePermission('users:manage'), route(async (_req, res) => {
        res.status(200).json({ items: await auth.listUsers() });
    }));
    router.get('/roles', requirePermission('users:manage'), (_req, res) => {
        res.status(200).json({ items: auth.roles() });
    });
    router.post('/users', requirePermission('users:manage'), route(async (req, res) => {
        res.status(201).json(await auth.createUser(req.body));
    }));
    router.patch('/users/:id', requirePermission('users:manage'), route(async (req, res) => {
        res.status(200).json(await auth.updateUser(req.params.id as string, req.body));
    }));
    router.post('/users/:id/password', requirePermission('users:manage'), route(async (req, res) => {
        const body = requireBody(req.body);
        await auth.resetPassword(req.params.id as string, body.password);
        res.status(204).send();
    }));
    router.get('/users/:id/access', requirePermission('users:manage'), route(async (req, res) => {
        res.status(200).json(await auth.getUserAccess(req.params.id as string));
    }));
    router.post('/users/:id/unlock', requirePermission('users:manage'), route(async (req, res) => {
        res.status(200).json(await auth.unlockUser(req.params.id as string));
    }));
    router.post('/users/:id/revoke-access', requirePermission('users:manage'), route(async (req, res) => {
        res.status(200).json(await auth.revokeUserAccess(req.params.id as string));
    }));
    router.delete('/users/:id/sessions/:sessionId', requirePermission('users:manage'), route(async (req, res) => {
        await auth.revokeUserSession(req.params.id as string, req.params.sessionId as string);
        res.status(204).send();
    }));
    router.delete('/users/:id/tokens/:tokenId', requirePermission('users:manage'), route(async (req, res) => {
        await auth.revokeUserApiToken(req.params.id as string, req.params.tokenId as string);
        res.status(204).send();
    }));

    router.get('/secrets', requirePermission('secrets:manage'), route(async (_req, res) => {
        res.status(200).json({ configured: secrets.configured, items: await secrets.list() });
    }));
    router.put('/secrets/:name', requirePermission('secrets:manage'), route(async (req, res) => {
        const body = requireBody(req.body);
        res.status(200).json(await secrets.put(
            req.params.name,
            body.value,
            body.description,
            req.auth!.userId,
            body.ownerUserId,
            body.expiresOn
        ));
    }));
    router.get('/secrets/:name/usage', requirePermission('secrets:manage'), route(async (req, res) => {
        res.status(200).json({ items: await secrets.usage(req.params.name) });
    }));
    router.delete('/secrets/:name', requirePermission('secrets:manage'), route(async (req, res) => {
        const force = parseForce(req.query.force);
        await secrets.delete(req.params.name, force);
        res.status(204).send();
    }));

    router.get('/system', requirePermission('system:read'), route(async (_req, res) => {
        const started = performance.now();
        await runtime.pool.query('SELECT 1');
        const databaseLatencyMs = Math.max(0, Math.round((performance.now() - started) * 10) / 10);
        const schema = await getSchemaVersions(runtime.pool);
        res.status(200).json({
            generatedAt: new Date().toISOString(),
            services: {
                executionManager: runtime.manager.started ? 'online' : 'offline',
                webhookDispatcher: runtime.webhookDispatcher?.started === true ? 'online' : 'offline'
            },
            database: {
                status: 'online',
                latencyMs: databaseLatencyMs,
                schemaVersion: schema.current,
                expectedSchemaVersion: schema.latest
            },
            workers: {
                concurrency: runtime.manager.capacity,
                schedulerPollMs: runtime.config.schedulerPollMs,
                shutdownGraceMs: runtime.config.shutdownGraceMs,
                databasePoolMax: runtime.config.dbPoolMax
            },
            webhooks: {
                concurrency: runtime.config.webhookConcurrency,
                pollMs: runtime.config.webhookPollMs,
                maxAttempts: runtime.config.webhookMaxAttempts,
                requestTimeoutMs: runtime.config.webhookRequestTimeoutMs,
                legacySigningKeyConfigured: runtime.config.webhookSigningKey !== undefined
            },
            authentication: {
                sessionTtlMs: runtime.config.authSessionTtlMs,
                sessionIdleMs: runtime.config.authSessionIdleMs,
                secureCookies: runtime.config.authCookieSecure,
                trustProxy: runtime.config.trustProxy
            },
            secrets: { configured: secrets.configured },
            retention: {
                mode: 'manual',
                dryRunCommand: 'npm run retention -- --days <days>',
                confirmCommand: 'npm run retention -- --days <days> --batch-size 500 --confirm'
            }
        });
    }));

    router.get('/audit', requirePermission('audit:read'), route(async (req, res) => {
        const limit = parseLimit(req.query.limit);
        const cursor = parseOptionalString(req.query.cursor, 'cursor');
        const page = parseOptionalPage(req.query.page);
        if (cursor !== undefined && page !== undefined) {
            throw new AppError('CONFLICTING_PAGINATION', 'page and cursor cannot be combined.', 400);
        }
        res.status(200).json(await audit.list({
            limit,
            ...(cursor === undefined ? {} : { cursor }),
            ...(page === undefined ? {} : { page }),
            ...parseAuditFilters(req.query)
        }));
    }));
    router.get('/audit/export', requirePermission('audit:read'), route(async (req, res) => {
        if (req.query.page !== undefined || req.query.cursor !== undefined || req.query.limit !== undefined) {
            throw new AppError('INVALID_EXPORT_PAGINATION', 'Audit exports do not accept page, cursor, or limit.', 400);
        }
        const format = parseOptionalString(req.query.format, 'format');
        if (format !== 'csv' && format !== 'json') {
            throw new AppError('INVALID_EXPORT_FORMAT', 'format must be csv or json.', 400);
        }
        const result = await audit.listForExport(parseAuditFilters(req.query), AUDIT_EXPORT_LIMIT);
        const filename = `audit-${new Date().toISOString().slice(0, 10)}.${format}`;
        res.set({
            'Content-Disposition': `attachment; filename=${filename}`,
            'X-Audit-Export-Total': String(result.total),
            'X-Audit-Export-Count': String(result.items.length),
            'X-Audit-Export-Truncated': String(result.truncated)
        });
        if (format === 'csv') {
            res.type('text/csv').status(200).send(toAuditCsv(result.items));
            return;
        }
        res.type('application/json').status(200).send(JSON.stringify({
            metadata: {
                total: result.total,
                exported: result.items.length,
                truncated: result.truncated,
                limit: AUDIT_EXPORT_LIMIT
            },
            items: result.items
        }, null, 2) + '\n');
    }));
    router.get('/audit/:id', requirePermission('audit:read'), route(async (req, res) => {
        const auditId = req.params.id as string;
        if (!/^[1-9]\d*$/u.test(auditId)) {
            throw new AppError('INVALID_AUDIT_ID', 'Audit event ID must be a positive integer.', 400);
        }
        const event = await audit.getById(auditId);
        if (event === undefined) {
            throw new AppError('AUDIT_EVENT_NOT_FOUND', `Audit event ${auditId} not found.`, 404);
        }
        res.status(200).json(event);
    }));
    return router;
}

function parseLimit(value: unknown): number {
    if (value === undefined) return 50;
    if (typeof value !== 'string' || !/^\d+$/u.test(value)) {
        throw new AppError('INVALID_LIMIT', 'limit must be an integer.', 400);
    }
    const parsed = Number(value);
    if (parsed < 1 || parsed > 200) throw new AppError('INVALID_LIMIT', 'limit must be between 1 and 200.', 400);
    return parsed;
}

function parseOptionalPage(value: unknown): number | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || !/^\d+$/u.test(value)) {
        throw new AppError('INVALID_PAGE', 'page must be an integer.', 400);
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
        throw new AppError('INVALID_PAGE', 'page must be at least 1.', 400);
    }
    return parsed;
}

function parseForce(value: unknown): boolean {
    if (value === undefined) return false;
    if (value === 'true') return true;
    throw new AppError('INVALID_FORCE', 'force must be true when provided.', 400);
}

function parseAuditFilters(query: Request['query']): Omit<AuditListOptions, 'limit' | 'cursor' | 'page'> {
    const action = parseOptionalString(query.action, 'action');
    const actorUserId = parseOptionalString(query.actorUserId, 'actorUserId');
    if (actorUserId !== undefined && !UUID.test(actorUserId)) {
        throw new AppError('INVALID_ACTOR_USER_ID', 'actorUserId must be a UUID.', 400);
    }
    const actorType = parseOptionalString(query.actorType, 'actorType');
    if (actorType !== undefined && !AUDIT_ACTOR_TYPES.has(actorType as AuditActorType)) {
        throw new AppError('INVALID_AUDIT_ACTOR_TYPE', 'actorType is unsupported.', 400);
    }
    const actorLabel = parseOptionalString(query.actorLabel, 'actorLabel');
    const resource = parseOptionalString(query.resource, 'resource');
    const resourceType = parseOptionalString(query.resourceType, 'resourceType');
    const resourceId = parseOptionalString(query.resourceId, 'resourceId');
    const outcome = parseOptionalString(query.outcome, 'outcome');
    if (outcome !== undefined && outcome !== 'success' && outcome !== 'failure') {
        throw new AppError('INVALID_AUDIT_OUTCOME', 'outcome must be success or failure.', 400);
    }
    const from = parseOptionalDate(query.from, 'from');
    const to = parseOptionalDate(query.to, 'to');
    if (from !== undefined && to !== undefined && from >= to) {
        throw new AppError('INVALID_DATE_RANGE', 'from must be earlier than to.', 400);
    }
    return {
        ...(action === undefined ? {} : { action }),
        ...(actorUserId === undefined ? {} : { actorUserId }),
        ...(actorType === undefined ? {} : { actorType: actorType as AuditActorType }),
        ...(actorLabel === undefined ? {} : { actorLabel }),
        ...(resource === undefined ? {} : { resource }),
        ...(resourceType === undefined ? {} : { resourceType }),
        ...(resourceId === undefined ? {} : { resourceId }),
        ...(outcome === undefined ? {} : { outcome }),
        ...(from === undefined ? {} : { from }),
        ...(to === undefined ? {} : { to })
    };
}

function parseOptionalDate(value: unknown, name: string): Date | undefined {
    const text = parseOptionalString(value, name);
    if (text === undefined) return undefined;
    const timestamp = Date.parse(text);
    if (!ISO_TIMESTAMP.test(text) || Number.isNaN(timestamp) || !hasValidCalendarComponents(text)) {
        throw new AppError('INVALID_' + name.toUpperCase(), name + ' must be a valid ISO-8601 timestamp.', 400);
    }
    return new Date(timestamp);
}

function hasValidCalendarComponents(value: string): boolean {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/u.exec(value);
    if (match === null) return false;
    const [year, month, day, hour, minute, second] = match.slice(1).map(Number) as [
        number, number, number, number, number, number
    ];
    const normalized = new Date(0);
    normalized.setUTCHours(hour, minute, second, 0);
    normalized.setUTCFullYear(year, month - 1, day);
    return normalized.getUTCFullYear() === year
        && normalized.getUTCMonth() === month - 1
        && normalized.getUTCDate() === day
        && normalized.getUTCHours() === hour
        && normalized.getUTCMinutes() === minute
        && normalized.getUTCSeconds() === second;
}

function parseOptionalString(value: unknown, name: string): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || value.length === 0) {
        throw new AppError('INVALID_' + name.toUpperCase(), name + ' must be a non-empty string.', 400);
    }
    return value;
}

function toAuditCsv(items: AuditEvent[]): string {
    const headers = [
        'timestamp', 'auditId', 'requestId', 'actorType', 'actorUserId', 'actorLabel',
        'action', 'outcome', 'statusCode', 'resourceType', 'resourceId',
        'ipAddress', 'userAgent', 'metadata'
    ];
    const rows = items.map(event => [
        event.createdAt, event.auditId, event.requestId, event.actorType,
        event.actorUserId, event.actorLabel, event.action, event.outcome,
        event.statusCode, event.resourceType, event.resourceId, event.ipAddress,
        event.userAgent, JSON.stringify(event.metadata)
    ].map(csvCell).join(','));
    const newline = String.fromCharCode(13, 10);
    return [headers.join(','), ...rows].join(newline) + newline;
}

function csvCell(value: string | number | null): string {
    const text = value === null ? '' : String(value);
    const quote = String.fromCharCode(34);
    return quote + text.replaceAll(quote, quote + quote) + quote;
}

function requireBody(value: unknown): Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new AppError('INVALID_REQUEST_BODY', 'Request body must be an object.', 422);
    }
    return value as Record<string, unknown>;
}

type Handler = (req: Request, res: Response) => Promise<void>;
function route(handler: Handler): (req: Request, res: Response, next: NextFunction) => void {
    return (req, res, next) => { void handler(req, res).catch(next); };
}
