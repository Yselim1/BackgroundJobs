import { Router, type Request, type Response } from 'express';
import { JobService, JobServiceError } from '../services/JobService.js';
import { JobValidationError } from '../utils/jobValidator.js';

const router = Router();
const jobService = new JobService();

router.get('/', async (req: Request, res: Response): Promise<void> => {
    try {
        const jobs = await jobService.getAllJobs();
        res.status(200).json(jobs);
    } catch (error: any) {
        sendControllerError(res, error);
    }
});

router.post('/validate', (req: Request,res: Response): void => {
    const result =
    jobService.validateJob(req.body);

    res.status(result.valid ? 200 : 422).json(result);
    }
);

router.post('/', async (req: Request, res: Response ): Promise<void> => {
    try {
        const job = await jobService.createJob(req.body);
        res.status(201).json(job);
    } catch (error: unknown) {
        sendControllerError(res, error);
    }
    }
);

router.get('/:id', async (req: Request, res: Response): Promise<void> => {
    try {
        const jobId = req.params.id as string;
        const job = await jobService.getJobWithID(jobId);

        res.status(200).json(job);
    } catch (error: any) {
        sendControllerError(res, error);
    }
});

router.put('/:id', async (req: Request, res: Response ): Promise<void> => {
    try {
        const jobId = req.params.id as string
        const job = await jobService.replaceJob( jobId, req.body)
        res.status(200).json(job);
    } catch (error: unknown) {
        sendControllerError(res, error);
    }
    }
);

router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
    try {
        const jobId = req.params.id as string;
        await jobService.deleteJob(jobId);
        res.status(204).send();
    } catch (error: unknown) {
        sendControllerError(res, error);
    }
    }
);

router.post('/:id/run', async (req: Request, res: Response): Promise<void> => {
    try {
        const jobId = req.params.id as string;
        const job = await jobService.getJobWithID(jobId);

        if (!job) {
            res.status(404).json({
                error: `Job with id ${jobId} not found.`
            });
            return;
        }

        const log = await jobService.runJob(job);

        res.status(log.status === 'success' ? 200 : 500).json({
            message: `Job ${jobId} execution completed with status: ${log.status}.`,
            log
        });
    } catch (error: any) {
        res.status(error.statusCode || 500).json({ error: error.message });
    }
});

function sendControllerError( res: Response, error: unknown): void {
    if (error instanceof JobValidationError) {
        res.status(422).json({error: 'Job definition validation failed.',details: error.issues});
        return;
    }

    if (error instanceof JobServiceError) {
        res.status(error.statusCode).json({error: error.message, code: error.code});
        return;
    }
    const message = error instanceof Error ? error.message : String(error);

    res.status(500).json({error: message});
}

export default router;