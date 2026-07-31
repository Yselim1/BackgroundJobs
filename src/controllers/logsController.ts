import { Router, type NextFunction, type Request, type Response } from 'express';
import { AppError } from '../errors.js';
import { ExecutionRepository } from '../repositories/ExecutionRepository.js';
import type { ExecutionDetail } from '../types/index.js';

export function createLogsController(executions: ExecutionRepository): Router {
    const router = Router();
    router.get('/', route(async (_req, res) => {
        const ids: string[] = [];
        let cursor: string | undefined;
        do {
            const page = await executions.list({ limit: 200, ...(cursor === undefined ? {} : { cursor }) });
            ids.push(...page.items.map(item => item.executionId));
            cursor = page.nextCursor ?? undefined;
        } while (cursor !== undefined);
        const details = await Promise.all(ids.map(id => executions.getDetail(id)));
        res.status(200).json(details.filter((item): item is ExecutionDetail => item !== undefined).map(toLegacyLog));
    }));
    router.get('/:id', route(async (req, res) => {
        const execution = await executions.getDetail(req.params.id as string);
        if (execution === undefined) throw new AppError('EXECUTION_NOT_FOUND', `Execution ${req.params.id} not found.`, 404);
        res.status(200).json(toLegacyLog(execution));
    }));
    return router;
}

export function toLegacyLog(execution: ExecutionDetail): Record<string, unknown> {
    return {
        logId: execution.executionId,
        executionId: execution.executionId,
        jobId: execution.jobId,
        trigger: execution.trigger,
        status: execution.status,
        startTime: execution.startedAt ?? execution.requestedAt,
        endTime: execution.finishedAt,
        durationMs: execution.durationMs,
        stepResults: execution.stepResults,
        ...(execution.error === null ? {} : { error: execution.error.message, errorCode: execution.error.code })
    };
}

type Handler = (req: Request, res: Response) => Promise<void>;
function route(handler: Handler): (req: Request, res: Response, next: NextFunction) => void {
    return (req, res, next) => { void handler(req, res).catch(next); };
}
