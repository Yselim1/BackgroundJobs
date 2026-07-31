import { Router, type NextFunction, type Request, type Response } from 'express';
import { JobService } from '../services/JobService.js';

export function createJobsController(jobService: JobService): Router {
    const router = Router();

    router.get('/', route(async (_req, res) => { res.status(200).json(await jobService.getAllJobs()); }));
    router.post('/validate', (req, res) => {
        const result = jobService.validateJob(req.body);
        res.status(result.valid ? 200 : 422).json(result);
    });
    router.post('/', route(async (req, res) => { res.status(201).json(await jobService.createJob(req.body)); }));
    router.get('/:id/plan', route(async (req, res) => { res.status(200).json(await jobService.getExecutionPlan(req.params.id as string)); }));
    router.get('/:id', route(async (req, res) => { res.status(200).json(await jobService.getJobWithID(req.params.id as string)); }));
    router.put('/:id', route(async (req, res) => { res.status(200).json(await jobService.replaceJob(req.params.id as string, req.body)); }));
    router.delete('/:id', route(async (req, res) => { await jobService.deleteJob(req.params.id as string); res.status(204).send(); }));
    router.post('/:id/run', route(async (req, res) => {
        const execution = await jobService.startJob(req.params.id as string);
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

type Handler = (req: Request, res: Response) => Promise<void>;
function route(handler: Handler): (req: Request, res: Response, next: NextFunction) => void {
    return (req, res, next) => { void handler(req, res).catch(next); };
}
