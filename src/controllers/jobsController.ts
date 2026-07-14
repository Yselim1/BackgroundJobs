import { Router, type Request, type Response } from 'express';
import { JobService } from '../services/JobService.js';

const router = Router();
const jobService = new JobService();

router.get('/', async (req: Request, res: Response): Promise<void> => {
    try {
        const jobs = await jobService.getAllJobs();
        res.status(200).json(jobs);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

router.get('/:id', async (req: Request, res: Response): Promise<void> => {
    try {
        const jobId = req.params.id as string;
        const job = await jobService.getJobWithID(jobId);

        res.status(200).json(job);
    } catch (error: any) {
        res.status(error.statusCode || 500).json({ error: error.message });
    }
});

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

export default router;