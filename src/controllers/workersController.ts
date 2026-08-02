import { Router, type NextFunction, type Request, type Response } from 'express';
import { requirePermission } from '../security/middleware.js';
import type { WorkerRepository } from '../repositories/WorkerRepository.js';
import { AppError } from '../errors.js';

export function createWorkersController(workers: WorkerRepository): Router {
    const router = Router();
    router.get('/', requirePermission('platform:read'), route(async (_req, res) => {
        res.status(200).json({ items: await workers.list() });
    }));
    router.post('/:id/drain', requirePermission('workers:manage'), route(async (req, res) => {
        res.status(200).json(await workers.setDesiredState(req.params.id as string, 'draining'));
    }));
    router.post('/:id/resume', requirePermission('workers:manage'), route(async (req, res) => {
        res.status(200).json(await workers.setDesiredState(req.params.id as string, 'accepting'));
    }));
    return router;
}

export function createQueuesController(workers: WorkerRepository): Router {
    const router = Router();
    router.get('/', requirePermission('platform:read'), route(async (_req, res) => {
        res.status(200).json({ items: await workers.queues() });
    }));
    router.get('/:name', requirePermission('platform:read'), route(async (req, res) => {
        res.status(200).json(await workers.queueDetail(parseQueueName(req.params.name)));
    }));
    router.patch('/:name', requirePermission('workers:manage'), route(async (req, res) => {
        const name = parseQueueName(req.params.name);
        const expectedVersion = parseVersion(req.get('If-Match'));
        const policy = await workers.updateQueuePolicy(name, parseQueuePatch(req.body), expectedVersion, req.auth!);
        res.setHeader('ETag', `${policy.version}`).status(200).json(policy);
    }));
    return router;
}

function parseQueueName(value: unknown): string {
    if (typeof value !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/u.test(value)) {
        throw new AppError('INVALID_QUEUE', 'Queue name is invalid.', 400);
    }
    return value;
}

function parseVersion(value: string | undefined): number {
    if (value === undefined) throw new AppError('QUEUE_POLICY_VERSION_REQUIRED', 'If-Match is required.', 428);
    const normalized = value.replace(/^W\//u, '').replace(/^"|"$/gu, '');
    if (!/^\d+$/u.test(normalized) || Number(normalized) < 1) throw new AppError('INVALID_QUEUE_POLICY_VERSION', 'If-Match must contain a positive version.', 400);
    return Number(normalized);
}

function parseQueuePatch(body: unknown): { paused?: boolean; maxRunning?: number | null; maxStarts?: number | null; intervalMs?: number | null } {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new AppError('INVALID_QUEUE_POLICY', 'Request body must be an object.', 422);
    const record = body as Record<string, unknown>;
    const unsupported = Object.keys(record).filter(key => !['paused', 'maxRunning', 'maxStarts', 'intervalMs'].includes(key));
    if (unsupported.length > 0) throw new AppError('INVALID_QUEUE_POLICY', `Unsupported queue policy field: ${unsupported[0]}.`, 422);
    if (Object.keys(record).length === 0) throw new AppError('INVALID_QUEUE_POLICY', 'At least one queue policy field is required.', 422);
    if (record.paused !== undefined && typeof record.paused !== 'boolean') throw new AppError('INVALID_QUEUE_POLICY', 'paused must be a boolean.', 422);
    for (const [name, value, max] of [
        ['maxRunning', record.maxRunning, 10000], ['maxStarts', record.maxStarts, 100000], ['intervalMs', record.intervalMs, 86400000]
    ] as const) {
        if (value !== undefined && value !== null && (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max)) {
            throw new AppError('INVALID_QUEUE_POLICY', `${name} must be null or an integer between 1 and ${max}.`, 422);
        }
    }
    return record as { paused?: boolean; maxRunning?: number | null; maxStarts?: number | null; intervalMs?: number | null };
}

type Handler = (req: Request, res: Response) => Promise<void>;
function route(handler: Handler): (req: Request, res: Response, next: NextFunction) => void {
    return (req, res, next) => { void handler(req, res).catch(next); };
}
