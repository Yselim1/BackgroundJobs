import { Router, type NextFunction, type Request, type Response } from 'express';
import { AppError } from '../errors.js';
import { JobService } from '../services/JobService.js';
import { requirePermission } from '../security/middleware.js';

export function createJobsController(jobService: JobService): Router {
    const router = Router();

    router.get('/', requirePermission('jobs:read'), route(async (_req, res) => { res.status(200).json(await jobService.getAllJobs()); }));
    router.post('/validate', requirePermission('jobs:write'), (req, res) => {
        const result = jobService.validateJob(req.body);
        res.status(result.valid ? 200 : 422).json(result);
    });
    router.post('/', requirePermission('jobs:write'), route(async (req, res) => { res.status(201).json(await jobService.createJob(req.body)); }));
    router.get('/:id/plan', requirePermission('jobs:read'), route(async (req, res) => { res.status(200).json(await jobService.getExecutionPlan(req.params.id as string)); }));
    router.get('/:id', requirePermission('jobs:read'), route(async (req, res) => { res.status(200).json(await jobService.getJobWithID(req.params.id as string)); }));
    router.put('/:id', requirePermission('jobs:write'), route(async (req, res) => { res.status(200).json(await jobService.replaceJob(req.params.id as string, req.body)); }));
    router.delete('/:id', requirePermission('jobs:write'), route(async (req, res) => { await jobService.deleteJob(req.params.id as string); res.status(204).send(); }));
    router.post('/:id/run', requirePermission('jobs:run'), route(async (req, res) => {
        const execution = await jobService.startJob(req.params.id as string, parseRunInput(req.body), req.auth);
        res.status(202).location(`/api/executions/${execution.executionId}`).json({
            executionId: execution.executionId,
            logId: execution.executionId,
            jobId: execution.jobId,
            trigger: 'manual',
            status: 'queued',
            requestedAt: execution.requestedAt
        });
    }));
    return router;
}

function parseRunInput(body: unknown): unknown {
    if (body === undefined) return undefined;
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        throw new AppError('INVALID_RUN_REQUEST', 'Request body must be an object containing an optional input object.', 422);
    }
    const record = body as Record<string, unknown>;
    const unsupported = Object.keys(record).filter(key => key !== 'input');
    if (unsupported.length > 0) {
        throw new AppError('INVALID_RUN_REQUEST', `Unsupported run request field: ${unsupported[0]}.`, 422);
    }
    return record.input;
}

type Handler = (req: Request, res: Response) => Promise<void>;
function route(handler: Handler): (req: Request, res: Response, next: NextFunction) => void {
    return (req, res, next) => { void handler(req, res).catch(next); };
}
