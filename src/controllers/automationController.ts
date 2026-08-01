import { Router, type NextFunction, type Request, type Response } from 'express';
import { AppError } from '../errors.js';
import type { AutomationRepository } from '../repositories/AutomationRepository.js';
import { requirePermission } from '../security/middleware.js';
import type { WebhookEventStatus } from '../types/index.js';

const TERMINAL = new Set<WebhookEventStatus>(['success', 'failed', 'cancelled', 'skipped']);

export function createAutomationController(automations: AutomationRepository): Router {
    const router = Router();
    router.get('/:id/triggers', requirePermission('jobs:read'), route(async (req, res) => {
        res.status(200).json({ items: await automations.list(req.params.id as string) });
    }));
    router.post('/:id/triggers', requirePermission('jobs:write'), route(async (req, res) => {
        const input = parseCreate(req.body);
        if (input.kind === 'webhook') {
            res.status(201).json(await automations.createWebhook(req.params.id as string, input.name, req.auth));
            return;
        }
        res.status(201).json(await automations.createChain(req.params.id as string, input.name,
            input.sourceJobId, input.terminalStatuses, req.auth));
    }));
    router.patch('/:id/triggers/:triggerId', requirePermission('jobs:write'), route(async (req, res) => {
        res.status(200).json(await automations.update(req.params.id as string, req.params.triggerId as string, parsePatch(req.body)));
    }));
    router.post('/:id/triggers/:triggerId/rotate-token', requirePermission('jobs:write'), route(async (req, res) => {
        res.status(200).json(await automations.rotateToken(req.params.id as string, req.params.triggerId as string));
    }));
    router.delete('/:id/triggers/:triggerId', requirePermission('jobs:write'), route(async (req, res) => {
        await automations.delete(req.params.id as string, req.params.triggerId as string);
        res.status(204).send();
    }));
    router.get('/:id/trigger-events', requirePermission('jobs:read'), route(async (req, res) => {
        const page = integer(req.query.page, 'page', 1, 1, Number.MAX_SAFE_INTEGER);
        const limit = integer(req.query.limit, 'limit', 25, 1, 100);
        res.status(200).json(await automations.listEvents(req.params.id as string, page, limit));
    }));
    return router;
}

export function createWebhookIngressController(automations: AutomationRepository): Router {
    const router = Router();
    router.post('/:triggerId', route(async (req, res) => {
        const authorization = req.get('Authorization');
        if (authorization === undefined || !authorization.startsWith('Bearer ')) {
            throw new AppError('WEBHOOK_TOKEN_REQUIRED', 'A webhook bearer token is required.', 401);
        }
        if (req.body === null || typeof req.body !== 'object' || Array.isArray(req.body)) {
            throw new AppError('INVALID_WEBHOOK_INPUT', 'Webhook body must be a JSON object.', 422);
        }
        const idempotencyKey = req.get('Idempotency-Key');
        if (idempotencyKey !== undefined && (idempotencyKey.length < 1 || idempotencyKey.length > 200)) {
            throw new AppError('INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key must contain 1 to 200 characters.', 400);
        }
        const execution = await automations.invokeWebhook(req.params.triggerId as string,
            authorization.slice('Bearer '.length), req.body as Record<string, unknown>, idempotencyKey);
        res.status(202).location(`/api/executions/${execution.executionId}`).json({
            executionId: execution.executionId, jobId: execution.jobId, trigger: execution.trigger,
            status: execution.status, requestedAt: execution.requestedAt
        });
    }));
    return router;
}

function parseCreate(body: unknown):
    | { kind: 'webhook'; name: string }
    | { kind: 'job_completion'; name: string; sourceJobId: string; terminalStatuses: WebhookEventStatus[] } {
    const value = record(body, 'trigger');
    const name = text(value.name, 'name');
    if (value.kind === 'webhook') return { kind: 'webhook', name };
    if (value.kind !== 'job_completion') throw new AppError('INVALID_TRIGGER_KIND', 'kind must be webhook or job_completion.', 422);
    return { kind: 'job_completion', name, sourceJobId: text(value.sourceJobId, 'sourceJobId'),
        terminalStatuses: statuses(value.terminalStatuses ?? ['success']) };
}

function parsePatch(body: unknown): { name?: string; enabled?: boolean; terminalStatuses?: WebhookEventStatus[] } {
    const value = record(body, 'trigger patch');
    const result: { name?: string; enabled?: boolean; terminalStatuses?: WebhookEventStatus[] } = {};
    if (value.name !== undefined) result.name = text(value.name, 'name');
    if (value.enabled !== undefined) {
        if (typeof value.enabled !== 'boolean') throw new AppError('INVALID_ENABLED', 'enabled must be boolean.', 422);
        result.enabled = value.enabled;
    }
    if (value.terminalStatuses !== undefined) result.terminalStatuses = statuses(value.terminalStatuses);
    if (Object.keys(result).length === 0) throw new AppError('EMPTY_TRIGGER_PATCH', 'At least one trigger field is required.', 422);
    return result;
}

function statuses(value: unknown): WebhookEventStatus[] {
    if (!Array.isArray(value) || value.length === 0) throw new AppError('INVALID_TERMINAL_STATUSES', 'terminalStatuses must be a non-empty array.', 422);
    const items = value.map(item => {
        if (typeof item !== 'string' || !TERMINAL.has(item as WebhookEventStatus)) {
            throw new AppError('INVALID_TERMINAL_STATUS', `Unsupported terminal status ${String(item)}.`, 422);
        }
        return item as WebhookEventStatus;
    });
    return [...new Set(items)];
}

function record(value: unknown, name: string): Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new AppError('INVALID_TRIGGER', `${name} must be an object.`, 422);
    return value as Record<string, unknown>;
}
function text(value: unknown, name: string): string {
    if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > 100) throw new AppError(`INVALID_${name.toUpperCase()}`, `${name} must contain 1 to 100 characters.`, 422);
    return value.trim();
}
function integer(value: unknown, name: string, fallback: number, min: number, max: number): number {
    if (value === undefined) return fallback;
    const parsed = typeof value === 'string' && /^\d+$/u.test(value) ? Number(value) : NaN;
    if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new AppError(`INVALID_${name.toUpperCase()}`, `${name} is invalid.`, 400);
    return parsed;
}

type Handler = (req: Request, res: Response) => Promise<void>;
function route(handler: Handler): (req: Request, res: Response, next: NextFunction) => void {
    return (req, res, next) => { void handler(req, res).catch(next); };
}
