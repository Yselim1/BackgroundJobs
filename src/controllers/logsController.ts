import { Router, type Request, type Response } from 'express';
import { JobLogStore } from '../storage/JobLogStore.js';

const router = Router();
const jobLogStore = new JobLogStore();

router.get('/', async (req: Request, res: Response): Promise<void> => {
    try {
        const logs = await jobLogStore.getAll();

        res.status(200).json([...logs].reverse());
    } catch (error: any) {
        res.status(500).json({
            error: error.message
        });
    }
});

router.get('/:id', async (req: Request, res: Response): Promise<void> => {
    try {
        const logId  = req.params.id as string;

        if (typeof req.params.id !== 'string') {
            res.status(400).json({ error: "Invalid ID parameter" });
            return;
        }

        const log = await jobLogStore.getById(logId);
        
        if (!log) {
            res.status(404).json({
                error: `Log with logId ${logId} not found.`
            });
            return;
        } 
        res.status(200).json(log);
    } catch (error: any) {
        res.status(500).json({
            error: error.message
        });
    }
});  

export default router;