import { Router, type NextFunction, type Request, type Response } from 'express';
import { AppError } from '../errors.js';
import { ExecutionRepository } from '../repositories/ExecutionRepository.js';
import { JobExecutionManager } from '../services/JobExecutionManager.js';
import type { ExecutionStatus } from '../types/index.js';

const STATUSES = new Set<ExecutionStatus>(['queued', 'running', 'success', 'failed', 'cancelled', 'skipped']);

export function createExecutionsController(executions: ExecutionRepository, manager: JobExecutionManager): Router {
    const router = Router();
    router.get('/', route(async (req, res) => {
        const limit = parseLimit(req.query.limit);
        const status = parseOptionalString(req.query.status, 'status');
        if (status !== undefined && !STATUSES.has(status as ExecutionStatus)) {
            throw new AppError('INVALID_STATUS', `Unsupported execution status ${status}.`, 400);
        }
        const jobId = parseOptionalString(req.query.jobId, 'jobId');
        const cursor = parseOptionalString(req.query.cursor, 'cursor');
        res.status(200).json(await executions.list({
            limit,
            ...(jobId === undefined ? {} : { jobId }),
            ...(status === undefined ? {} : { status: status as ExecutionStatus }),
            ...(cursor === undefined ? {} : { cursor })
        }));
    }));
    router.get('/:id', route(async (req, res) => {
        const execution = await executions.getDetail(req.params.id as string);
        if (execution === undefined) throw new AppError('EXECUTION_NOT_FOUND', `Execution ${req.params.id} not found.`, 404);
        res.status(200).json(execution);
    }));
    router.post('/:id/cancel', route(async (req, res) => {
        res.status(200).json(await manager.cancel(req.params.id as string));
    }));
    return router;
}

function parseLimit(value: unknown): number {
    if (value === undefined) return 50;
    if (typeof value !== 'string' || !/^\d+$/u.test(value)) throw new AppError('INVALID_LIMIT', 'limit must be an integer.', 400);
    const parsed = Number(value);
    if (parsed < 1 || parsed > 200) throw new AppError('INVALID_LIMIT', 'limit must be between 1 and 200.', 400);
    return parsed;
}

function parseOptionalString(value: unknown, name: string): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || value.length === 0) throw new AppError(`INVALID_${name.toUpperCase()}`, `${name} must be a non-empty string.`, 400);
    return value;
}

type Handler = (req: Request, res: Response) => Promise<void>;
function route(handler: Handler): (req: Request, res: Response, next: NextFunction) => void {
    return (req, res, next) => { void handler(req, res).catch(next); };
}
