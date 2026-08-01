import { Router, type NextFunction, type Request, type Response } from 'express';
import { requirePermission } from '../security/middleware.js';
import type { WorkerRepository } from '../repositories/WorkerRepository.js';

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
    return router;
}

type Handler = (req: Request, res: Response) => Promise<void>;
function route(handler: Handler): (req: Request, res: Response, next: NextFunction) => void {
    return (req, res, next) => { void handler(req, res).catch(next); };
}
