import { Router, type NextFunction, type Request, type Response } from 'express';
import { AppError } from '../errors.js';
import { AttentionRepository } from '../repositories/AttentionRepository.js';
import { ExecutionRepository } from '../repositories/ExecutionRepository.js';
import { requirePermission } from '../security/middleware.js';
import type { WebhookDispatcher } from '../services/WebhookDispatcher.js';
import type { AttentionKind, AttentionSeverity, AttentionState, AuthenticatedActor } from '../types/index.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const STATES = new Set<AttentionState>(['open', 'acknowledged', 'snoozed', 'ignored', 'resolved']);
const SEVERITIES = new Set<AttentionSeverity>(['critical', 'high', 'medium', 'low']);
const KINDS = new Set<AttentionKind>(['execution_failure', 'webhook_failure']);
const LIMITS = new Set([25, 50, 100]);
const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;

export function createAttentionController(
    attention: AttentionRepository,
    executions: ExecutionRepository,
    webhookDispatcher?: WebhookDispatcher
): Router {
    const router = Router();
    router.use((_req, res, next) => {
        res.setHeader('Cache-Control', 'no-store');
        next();
    });

    router.get('/', requirePermission('attention:read'), route(async (req, res) => {
        const stateText = parseOptionalString(req.query.state, 'state') ?? 'open';
        if (!STATES.has(stateText as AttentionState)) {
            throw new AppError('INVALID_ATTENTION_STATE', 'state must be open, acknowledged, snoozed, ignored, or resolved.', 400);
        }
        const kindText = parseOptionalString(req.query.kind, 'kind');
        if (kindText !== undefined && !KINDS.has(kindText as AttentionKind)) {
            throw new AppError(
                'INVALID_ATTENTION_KIND',
                'kind must be execution_failure or webhook_failure.',
                400
            );
        }
        const page = parsePage(req.query.page);
        const limit = parseLimit(req.query.limit);
        const search = parseOptionalString(req.query.search, 'search')?.trim();
        if (search !== undefined && (search.length === 0 || search.length > 200)) {
            throw new AppError('INVALID_ATTENTION_SEARCH', 'search must contain between 1 and 200 characters.', 400);
        }
        const from = parseCalendarDate(req.query.from, 'from');
        const to = parseCalendarDate(req.query.to, 'to');
        if (from !== undefined && to !== undefined && from.getTime() > to.getTime()) {
            throw new AppError('INVALID_ATTENTION_DATE_RANGE', 'from must be on or before to.', 400);
        }
        const toExclusive = to === undefined
            ? undefined
            : new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate() + 1));
        res.status(200).json(await attention.list({
            page,
            limit,
            state: stateText as AttentionState,
            ...(kindText === undefined ? {} : { kind: kindText as AttentionKind }),
            ...(search === undefined ? {} : { search }),
            ...(from === undefined ? {} : { from }),
            ...(toExclusive === undefined ? {} : { toExclusive })
        }));
    }));

    router.post('/bulk', requirePermission('attention:manage'), route(async (req, res) => {
        const request = parseBulkAction(req.body);
        const items: unknown[] = [];
        for (const attentionId of request.attentionIds) {
            items.push(await performAction(attention, executions, attentionId, request.action, request.value, req.auth!));
        }
        if (request.action === 'retry_webhook') await webhookDispatcher?.wake();
        res.status(200).json({ items });
    }));

    router.get('/:id', requirePermission('attention:read'), route(async (req, res) => {
        const attentionId = parseAttentionId(req.params.id);
        const item = await attention.getById(attentionId);
        if (item === undefined) {
            throw new AppError('ATTENTION_NOT_FOUND', `Attention item ${attentionId} was not found.`, 404);
        }
        res.status(200).json(item);
    }));

    router.post('/:id/ignore', requirePermission('attention:manage'), route(async (req, res) => {
        res.status(200).json(await attention.ignore(parseAttentionId(req.params.id), req.auth!));
    }));

    router.post('/:id/restore', requirePermission('attention:manage'), route(async (req, res) => {
        res.status(200).json(await attention.restore(parseAttentionId(req.params.id), req.auth!));
    }));

    router.post('/:id/acknowledge', requirePermission('attention:manage'), route(async (req, res) => {
        res.status(200).json(await attention.acknowledge(parseAttentionId(req.params.id), req.auth!));
    }));

    router.post('/:id/snooze', requirePermission('attention:manage'), route(async (req, res) => {
        const until = parseSnooze(req.body);
        res.status(200).json(await attention.snooze(parseAttentionId(req.params.id), until, req.auth!));
    }));

    router.post('/:id/assign', requirePermission('attention:manage'), route(async (req, res) => {
        res.status(200).json(await attention.assign(parseAttentionId(req.params.id), parseAssignee(req.body), req.auth!));
    }));

    router.post('/:id/severity', requirePermission('attention:manage'), route(async (req, res) => {
        res.status(200).json(await attention.setSeverity(parseAttentionId(req.params.id), parseSeverity(req.body), req.auth!));
    }));

    router.post('/:id/resolve', requirePermission('attention:manage'), route(async (req, res) => {
        res.status(200).json(await attention.resolve(parseAttentionId(req.params.id), parseResolutionNote(req.body), req.auth!));
    }));

    router.get('/:id/events', requirePermission('attention:read'), route(async (req, res) => {
        res.status(200).json({ items: await attention.events(parseAttentionId(req.params.id)) });
    }));

    router.post('/:id/replay', requirePermission('attention:manage'), route(async (req, res) => {
        const attentionId = parseAttentionId(req.params.id);
        const item = await requireAttention(attention, attentionId);
        const execution = await executions.enqueueReplay(item.executionId, req.auth!, parseReplayAction(req.body));
        const incident = await attention.resolve(attentionId, `Replayed as execution ${execution.executionId}.`, req.auth!);
        res.status(202).json({ incident, execution });
    }));

    router.post('/:id/rerun', requirePermission('attention:manage'), route(async (req, res) => {
        res.status(200).json(await attention.rerun(parseAttentionId(req.params.id), executions, req.auth!));
    }));

    router.post('/:id/retry-webhook', requirePermission('attention:manage'), route(async (req, res) => {
        const attentionId = parseAttentionId(req.params.id);
        if (await attention.getById(attentionId) === undefined) {
            throw new AppError('ATTENTION_NOT_FOUND', `Attention item ${attentionId} was not found.`, 404);
        }
        if (webhookDispatcher === undefined || !webhookDispatcher.started) {
            throw new AppError(
                'WEBHOOK_DISPATCHER_UNAVAILABLE',
                'The webhook dispatcher is not running, so this delivery cannot be retried now.',
                409
            );
        }
        const item = await attention.retryWebhook(attentionId, req.auth!);
        await webhookDispatcher.wake();
        res.status(200).json(item);
    }));

    return router;
}

async function requireAttention(attention: AttentionRepository, id: string) {
    const item = await attention.getById(id);
    if (item === undefined) throw new AppError('ATTENTION_NOT_FOUND', `Attention item ${id} was not found.`, 404);
    return item;
}

async function performAction(
    attention: AttentionRepository,
    executions: ExecutionRepository,
    id: string,
    action: string,
    value: unknown,
    actor: AuthenticatedActor
): Promise<unknown> {
    switch (action) {
        case 'acknowledge': return attention.acknowledge(id, actor);
        case 'ignore': return attention.ignore(id, actor);
        case 'restore': return attention.restore(id, actor);
        case 'assign': return attention.assign(id, typeof value === 'string' ? value : null, actor);
        case 'severity': return attention.setSeverity(id, value as AttentionSeverity, actor);
        case 'snooze': return attention.snooze(id, new Date(String(value)), actor);
        case 'resolve': return attention.resolve(id, typeof value === 'string' ? value : 'Resolved in bulk.', actor);
        case 'replay': {
            const item = await requireAttention(attention, id);
            const execution = await executions.enqueueReplay(item.executionId, actor);
            return { incident: await attention.resolve(id, `Replayed as execution ${execution.executionId}.`, actor), execution };
        }
        case 'resume': {
            if (typeof value !== 'string') throw new AppError('INVALID_BULK_ACTION', 'resume requires a step ID value.', 422);
            const item = await requireAttention(attention, id);
            const execution = await executions.enqueueReplay(item.executionId, actor, { resumeStepId: value });
            return { incident: await attention.resolve(id, `Resumed as execution ${execution.executionId}.`, actor), execution };
        }
        case 'retry_webhook': return attention.retryWebhook(id, actor);
        default: throw new AppError('INVALID_BULK_ACTION', `Unsupported incident action ${action}.`, 422);
    }
}

function parseBulkAction(body: unknown): { attentionIds: string[]; action: string; value: unknown } {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new AppError('INVALID_BULK_ACTION', 'Request body must be an object.', 422);
    const record = body as Record<string, unknown>;
    if (!Array.isArray(record.attentionIds) || record.attentionIds.length < 1 || record.attentionIds.length > 100) {
        throw new AppError('INVALID_BULK_ACTION', 'attentionIds must contain between 1 and 100 IDs.', 422);
    }
    const ids = record.attentionIds.map(parseAttentionId);
    if (new Set(ids).size !== ids.length || typeof record.action !== 'string') throw new AppError('INVALID_BULK_ACTION', 'attentionIds must be unique and action is required.', 422);
    if (record.action === 'severity' && !SEVERITIES.has(record.value as AttentionSeverity)) throw new AppError('INVALID_BULK_ACTION', 'A valid severity value is required.', 422);
    return { attentionIds: ids, action: record.action, value: record.value };
}

function parseSnooze(body: unknown): Date {
    const value = isRecord(body) ? body.until : undefined;
    if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw new AppError('INVALID_SNOOZE_UNTIL', 'until must be an ISO-8601 timestamp.', 422);
    return new Date(value);
}

function parseAssignee(body: unknown): string | null {
    const value = isRecord(body) ? body.userId : undefined;
    if (value === null) return null;
    if (typeof value !== 'string' || !UUID.test(value)) throw new AppError('INVALID_ASSIGNEE', 'userId must be a user UUID or null.', 422);
    return value;
}

function parseSeverity(body: unknown): AttentionSeverity {
    const value = isRecord(body) ? body.severity : undefined;
    if (!SEVERITIES.has(value as AttentionSeverity)) throw new AppError('INVALID_SEVERITY', 'severity must be critical, high, medium, or low.', 422);
    return value as AttentionSeverity;
}

function parseResolutionNote(body: unknown): string {
    const value = isRecord(body) ? body.note : undefined;
    if (typeof value !== 'string' || value.trim().length < 1 || value.length > 2000) throw new AppError('INVALID_RESOLUTION_NOTE', 'note must contain between 1 and 2000 characters.', 422);
    return value.trim();
}

function parseReplayAction(body: unknown): { useCurrentDefinition?: boolean; resumeStepId?: string } {
    if (body === undefined) return {};
    if (!isRecord(body)) throw new AppError('INVALID_REPLAY', 'Request body must be an object.', 422);
    if (body.useCurrentDefinition !== undefined && typeof body.useCurrentDefinition !== 'boolean') throw new AppError('INVALID_REPLAY', 'useCurrentDefinition must be a boolean.', 422);
    if (body.resumeStepId !== undefined && (typeof body.resumeStepId !== 'string' || body.resumeStepId.trim().length === 0)) throw new AppError('INVALID_REPLAY', 'resumeStepId must be a non-empty string.', 422);
    return { ...(typeof body.useCurrentDefinition === 'boolean' ? { useCurrentDefinition: body.useCurrentDefinition } : {}),
        ...(typeof body.resumeStepId === 'string' ? { resumeStepId: body.resumeStepId.trim() } : {}) };
}

function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }

function parseAttentionId(value: unknown): string {
    if (typeof value !== 'string' || !UUID.test(value)) {
        throw new AppError('INVALID_ATTENTION_ID', 'Attention item ID must be a UUID.', 400);
    }
    return value;
}

function parsePage(value: unknown): number {
    if (value === undefined) return 1;
    if (typeof value !== 'string' || !/^\d+$/u.test(value)) {
        throw new AppError('INVALID_PAGE', 'page must be an integer.', 400);
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
        throw new AppError('INVALID_PAGE', 'page must be at least 1.', 400);
    }
    return parsed;
}

function parseLimit(value: unknown): 25 | 50 | 100 {
    if (value === undefined) return 25;
    if (typeof value !== 'string' || !/^\d+$/u.test(value)) {
        throw new AppError('INVALID_LIMIT', 'limit must be 25, 50, or 100.', 400);
    }
    const parsed = Number(value);
    if (!LIMITS.has(parsed)) {
        throw new AppError('INVALID_LIMIT', 'limit must be 25, 50, or 100.', 400);
    }
    return parsed as 25 | 50 | 100;
}

function parseOptionalString(value: unknown, name: string): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || value.length === 0) {
        throw new AppError(`INVALID_${name.toUpperCase()}`, `${name} must be a non-empty string.`, 400);
    }
    return value;
}

function parseCalendarDate(value: unknown, name: string): Date | undefined {
    const text = parseOptionalString(value, name);
    if (text === undefined) return undefined;
    const match = CALENDAR_DATE.exec(text);
    if (match === null) {
        throw new AppError(
            `INVALID_${name.toUpperCase()}`,
            `${name} must be a calendar date in YYYY-MM-DD format.`,
            400
        );
    }
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
        throw new AppError(`INVALID_${name.toUpperCase()}`, `${name} must be a valid calendar date.`, 400);
    }
    return date;
}

type Handler = (req: Request, res: Response) => Promise<void>;
function route(handler: Handler): (req: Request, res: Response, next: NextFunction) => void {
    return (req, res, next) => { void handler(req, res).catch(next); };
}
