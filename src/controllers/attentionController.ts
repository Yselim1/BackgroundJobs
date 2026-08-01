import { Router, type NextFunction, type Request, type Response } from 'express';
import { AppError } from '../errors.js';
import { AttentionRepository } from '../repositories/AttentionRepository.js';
import { ExecutionRepository } from '../repositories/ExecutionRepository.js';
import { requirePermission } from '../security/middleware.js';
import type { WebhookDispatcher } from '../services/WebhookDispatcher.js';
import type { AttentionKind, AttentionState } from '../types/index.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const STATES = new Set<AttentionState>(['open', 'ignored', 'resolved']);
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
            throw new AppError('INVALID_ATTENTION_STATE', 'state must be open, ignored, or resolved.', 400);
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
