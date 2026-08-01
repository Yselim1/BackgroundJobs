import { Router, type NextFunction, type Request, type Response } from 'express';
import { AppError } from '../errors.js';
import { ExecutionRepository } from '../repositories/ExecutionRepository.js';
import { JobExecutionManager } from '../services/JobExecutionManager.js';
import type { ExecutionStatus, ExecutionTrigger } from '../types/index.js';
import { requirePermission } from '../security/middleware.js';

const STATUSES = new Set<ExecutionStatus>(['queued', 'running', 'success', 'failed', 'cancelled', 'skipped']);
const TRIGGERS = new Set<ExecutionTrigger>(['manual', 'scheduled', 'webhook', 'job_completion']);
const TERMINAL_STATUSES = new Set<ExecutionStatus>(['success', 'failed', 'cancelled', 'skipped']);
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;

export function createExecutionsController(executions: ExecutionRepository, manager: JobExecutionManager): Router {
    const router = Router();
    router.get('/', requirePermission('executions:read'), route(async (req, res) => {
        const limit = parseLimit(req.query.limit);
        const status = parseOptionalString(req.query.status, 'status');
        if (status !== undefined && !STATUSES.has(status as ExecutionStatus)) {
            throw new AppError('INVALID_STATUS', `Unsupported execution status ${status}.`, 400);
        }
        const jobId = parseOptionalString(req.query.jobId, 'jobId');
        const trigger = parseOptionalString(req.query.trigger, 'trigger');
        if (trigger !== undefined && !TRIGGERS.has(trigger as ExecutionTrigger)) {
            throw new AppError('INVALID_TRIGGER', `Unsupported execution trigger ${trigger}.`, 400);
        }
        const from = parseOptionalDate(req.query.from, 'from');
        const to = parseOptionalDate(req.query.to, 'to');
        if (from !== undefined && to !== undefined && from >= to) {
            throw new AppError('INVALID_DATE_RANGE', 'from must be earlier than to.', 400);
        }
        const cursor = parseOptionalString(req.query.cursor, 'cursor');
        const page = parseOptionalPage(req.query.page);
        if (cursor !== undefined && page !== undefined) {
            throw new AppError('CONFLICTING_PAGINATION', 'page and cursor cannot be combined.', 400);
        }
        const order = parseOptionalString(req.query.order, 'order') ?? 'desc';
        if (order !== 'asc' && order !== 'desc') {
            throw new AppError('INVALID_ORDER', 'order must be asc or desc.', 400);
        }
        res.status(200).json(await executions.list({
            limit,
            order,
            ...(jobId === undefined ? {} : { jobId }),
            ...(status === undefined ? {} : { status: status as ExecutionStatus }),
            ...(trigger === undefined ? {} : { trigger: trigger as ExecutionTrigger }),
            ...(from === undefined ? {} : { from }),
            ...(to === undefined ? {} : { to }),
            ...(cursor === undefined ? {} : { cursor }),
            ...(page === undefined ? {} : { page })
        }));
    }));
    router.get('/events', requirePermission('executions:read'), (req, res, next) => {
        void streamAllEvents(executions, req, res).catch(error => {
            if (res.headersSent) {
                res.write(`event: error\ndata: ${JSON.stringify({ error: 'Event stream failed.' })}\n\n`);
                res.end();
                return;
            }
            next(error);
        });
    });
    router.get('/:id/events', requirePermission('executions:read'), (req, res, next) => {
        void streamEvents(executions, req, res).catch(error => {
            if (res.headersSent) {
                res.write(`event: error\ndata: ${JSON.stringify({ error: 'Event stream failed.' })}\n\n`);
                res.end();
                return;
            }
            next(error);
        });
    });
    router.get('/:id/webhooks', requirePermission('executions:read'), route(async (req, res) => {
        const executionId = req.params.id as string;
        if (await executions.getSummary(executionId) === undefined) {
            throw new AppError('EXECUTION_NOT_FOUND', `Execution ${executionId} not found.`, 404);
        }
        res.status(200).json(await executions.listWebhookDeliveries(executionId));
    }));
    router.get('/:id', requirePermission('executions:read'), route(async (req, res) => {
        const execution = await executions.getDetail(req.params.id as string);
        if (execution === undefined) throw new AppError('EXECUTION_NOT_FOUND', `Execution ${req.params.id} not found.`, 404);
        res.status(200).json(execution);
    }));
    router.post('/:id/cancel', requirePermission('executions:cancel'), route(async (req, res) => {
        res.status(200).json(await manager.cancel(req.params.id as string, req.auth));
    }));
    return router;
}

async function streamAllEvents(executions: ExecutionRepository, req: Request, res: Response): Promise<void> {
    const suppliedCursor = req.headers['last-event-id'] ?? req.query.after;
    let cursor = suppliedCursor === undefined
        ? await executions.latestEventId()
        : parseEventCursor(suppliedCursor);
    res.status(200);
    res.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'
    });
    res.flushHeaders();

    let closed = false;
    let lastHeartbeat = Date.now();
    req.once('close', () => { closed = true; });
    while (!closed) {
        const events = await executions.listEventsAfter(cursor, 200);
        for (const event of events) {
            cursor = BigInt(event.eventId);
            res.write(`id: ${event.eventId}\nevent: execution.update\ndata: ${JSON.stringify(event)}\n\n`);
        }
        if (Date.now() - lastHeartbeat >= 15_000) {
            res.write(': heartbeat\n\n');
            lastHeartbeat = Date.now();
        }
        await new Promise(resolve => setTimeout(resolve, 250));
    }
}

async function streamEvents(executions: ExecutionRepository, req: Request, res: Response): Promise<void> {
    const executionId = req.params.id as string;
    if (await executions.getSummary(executionId) === undefined) {
        throw new AppError('EXECUTION_NOT_FOUND', `Execution ${executionId} not found.`, 404);
    }
    let cursor = parseEventCursor(req.headers['last-event-id'] ?? req.query.after);
    res.status(200);
    res.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'
    });
    res.flushHeaders();

    let closed = false;
    let lastHeartbeat = Date.now();
    req.once('close', () => { closed = true; });
    while (!closed) {
        // Read the state first. If it is terminal, the following event query
        // is guaranteed to observe the terminal event from the same commit.
        const summary = await executions.getSummary(executionId);
        const events = await executions.listEvents(executionId, cursor, 200);
        for (const event of events) {
            cursor = BigInt(event.eventId);
            res.write(`id: ${event.eventId}\nevent: ${event.type}\ndata: ${JSON.stringify({
                executionId: event.executionId,
                type: event.type,
                payload: event.payload,
                createdAt: event.createdAt
            })}\n\n`);
        }
        if (summary !== undefined && TERMINAL_STATUSES.has(summary.status) && events.length < 200) {
            res.end();
            return;
        }
        if (Date.now() - lastHeartbeat >= 15_000) {
            res.write(': heartbeat\n\n');
            lastHeartbeat = Date.now();
        }
        await new Promise(resolve => setTimeout(resolve, 250));
    }
}

function parseLimit(value: unknown): number {
    if (value === undefined) return 50;
    if (typeof value !== 'string' || !/^\d+$/u.test(value)) throw new AppError('INVALID_LIMIT', 'limit must be an integer.', 400);
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

function parseOptionalString(value: unknown, name: string): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || value.length === 0) throw new AppError(`INVALID_${name.toUpperCase()}`, `${name} must be a non-empty string.`, 400);
    return value;
}

function parseOptionalDate(value: unknown, name: string): Date | undefined {
    const text = parseOptionalString(value, name);
    if (text === undefined) return undefined;
    const timestamp = Date.parse(text);
    if (!ISO_TIMESTAMP.test(text) || Number.isNaN(timestamp) || !hasValidCalendarComponents(text)) {
        throw new AppError(`INVALID_${name.toUpperCase()}`, `${name} must be a valid ISO-8601 timestamp.`, 400);
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

function parseEventCursor(value: unknown): bigint {
    if (value === undefined) return 0n;
    const text = Array.isArray(value) ? value[0] : value;
    if (typeof text !== 'string' || !/^\d+$/u.test(text)) {
        throw new AppError('INVALID_EVENT_CURSOR', 'Last-Event-ID or after must be a non-negative integer.', 400);
    }
    return BigInt(text);
}

type Handler = (req: Request, res: Response) => Promise<void>;
function route(handler: Handler): (req: Request, res: Response, next: NextFunction) => void {
    return (req, res, next) => { void handler(req, res).catch(next); };
}
