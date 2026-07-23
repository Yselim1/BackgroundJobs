import { Router, type Request, type Response } from 'express';
import { JobLogStore } from '../storage/JobLogStore.js';
import { jobExecutionManager } from '../services/JobExecutionManager.js';

const router = Router();
const jobLogStore = new JobLogStore();

router.get('/', async (req: Request, res: Response): Promise<void> => {
    try {
        const activeLogs = jobExecutionManager.getAllActiveLogs();
        const persistedLogs = await jobLogStore.getAll();
        const activeLogIds = new Set(activeLogs.map(log => log.logId));

        const logs = [...activeLogs, ...persistedLogs.filter(log => !activeLogIds.has(log.logId))]
                    .sort((firstLog, secondLog) =>secondLog.startTime.localeCompare(firstLog.startTime));

        res.status(200).json(logs);
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);

        res.status(500).json({error: message});
    }
});

router.get('/:id', async (req: Request, res: Response): Promise<void> => {
    try {
        const logId = req.params.id;

        if (typeof logId !== 'string') {
            res.status(400).json({error: 'Invalid ID parameter.'});
            return;
        }

        const activeLog = jobExecutionManager.getActiveLog(logId);

        if (activeLog !== undefined) {
            res.status(200).json(activeLog);
            return;
        }

        const persistedLog = await jobLogStore.getById(logId);

        if (persistedLog === undefined) {
            res.status(404).json({error: `Log with logId ${logId} not found.`});
            return;
        }

        res.status(200).json(persistedLog);
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        res.status(500).json({error: message});
    }
});  

export default router;