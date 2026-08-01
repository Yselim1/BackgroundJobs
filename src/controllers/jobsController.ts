import { Router, type NextFunction, type Request, type Response } from 'express';
import { AppError } from '../errors.js';
import { JobService } from '../services/JobService.js';
import { requirePermission } from '../security/middleware.js';
import type { JobStatus } from '../types/index.js';

export function createJobsController(jobService: JobService): Router {
    const router = Router();

    router.get('/', requirePermission('jobs:read'), route(async (_req, res) => { res.status(200).json(await jobService.getAllJobs()); }));
    router.post('/validate', requirePermission('jobs:write'), (req, res) => {
        const result = jobService.validateJob(req.body);
        res.status(result.valid ? 200 : 422).json(result);
    });
    router.post('/schedule-preview', requirePermission('jobs:write'), route(async (req, res) => {
        res.status(200).json(await jobService.previewSchedule(req.body));
    }));
    router.post('/bulk-status', requirePermission('jobs:write'), route(async (req, res) => {
        const input = parseBulkStatus(req.body);
        res.status(200).json({ items: await jobService.setJobStatuses(input.jobIds, input.status, req.auth) });
    }));
    router.post('/', requirePermission('jobs:write'), route(async (req, res) => {
        const job = await jobService.createJob(req.body, req.auth);
        res.setHeader('ETag', `"${job.version}"`).status(201).json(job);
    }));
    router.get('/:id/versions', requirePermission('jobs:read'), route(async (req, res) => {
        const { page, limit } = parsePage(req.query.page, req.query.limit);
        res.status(200).json(await jobService.listJobVersions(req.params.id as string, page, limit));
    }));
    router.get('/:id/versions/:version', requirePermission('jobs:read'), route(async (req, res) => {
        res.status(200).json(await jobService.getJobVersion(req.params.id as string, positiveInteger(req.params.version, 'version')));
    }));
    router.post('/:id/rollback', requirePermission('jobs:write'), route(async (req, res) => {
        const body = parseRollback(req.body);
        const job = await jobService.rollbackJob(req.params.id as string, body.targetVersion, body.expectedVersion, req.auth);
        res.setHeader('ETag', `"${job.version}"`).status(200).json(job);
    }));
    router.get('/:id/plan', requirePermission('jobs:read'), route(async (req, res) => { res.status(200).json(await jobService.getExecutionPlan(req.params.id as string)); }));
    router.get('/:id', requirePermission('jobs:read'), route(async (req, res) => {
        const job = await jobService.getJobWithID(req.params.id as string);
        res.setHeader('ETag', `"${job.version}"`).status(200).json(job);
    }));
    router.put('/:id', requirePermission('jobs:write'), route(async (req, res) => {
        const job = await jobService.replaceJob(req.params.id as string, req.body, parseIfMatch(req.get('If-Match')), req.auth);
        res.setHeader('ETag', `"${job.version}"`).status(200).json(job);
    }));
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

function parseBulkStatus(body: unknown): { jobIds: string[]; status: JobStatus } {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        throw new AppError('INVALID_BULK_STATUS', 'Request body must be an object.', 422);
    }
    const record = body as Record<string, unknown>;
    const unsupported = Object.keys(record).filter(key => key !== 'jobIds' && key !== 'status');
    if (unsupported.length > 0) {
        throw new AppError('INVALID_BULK_STATUS', `Unsupported bulk-status field: ${unsupported[0]}.`, 422);
    }
    if (!Array.isArray(record.jobIds) || record.jobIds.length < 1 || record.jobIds.length > 100) {
        throw new AppError('INVALID_BULK_STATUS', 'jobIds must contain between 1 and 100 job IDs.', 422);
    }
    const jobIds = record.jobIds.map((value, index) => {
        if (typeof value !== 'string' || value.trim().length === 0) {
            throw new AppError('INVALID_BULK_STATUS', `jobIds[${index}] must be a non-empty string.`, 422);
        }
        return value.trim();
    });
    if (new Set(jobIds).size !== jobIds.length) {
        throw new AppError('INVALID_BULK_STATUS', 'jobIds cannot contain duplicates.', 422);
    }
    if (record.status !== 'active' && record.status !== 'inactive') {
        throw new AppError('INVALID_BULK_STATUS', 'status must be active or inactive.', 422);
    }
    return { jobIds, status: record.status };
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

function parseIfMatch(value: string | undefined): number {
    if (value === undefined) throw new AppError('JOB_VERSION_REQUIRED', 'If-Match must contain the current job version.', 428);
    return positiveInteger(value.replace(/^W\//u, '').replace(/^"|"$/gu, ''), 'If-Match');
}

function parseRollback(body: unknown): { targetVersion: number; expectedVersion: number } {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        throw new AppError('INVALID_ROLLBACK', 'Request body must be an object.', 422);
    }
    const value = body as Record<string, unknown>;
    return { targetVersion: positiveInteger(value.targetVersion, 'targetVersion'), expectedVersion: positiveInteger(value.expectedVersion, 'expectedVersion') };
}

function parsePage(pageValue: unknown, limitValue: unknown): { page: number; limit: number } {
    const page = pageValue === undefined ? 1 : positiveInteger(pageValue, 'page');
    const limit = limitValue === undefined ? 25 : positiveInteger(limitValue, 'limit');
    if (limit > 100) throw new AppError('INVALID_LIMIT', 'limit cannot exceed 100.', 400);
    return { page, limit };
}

function positiveInteger(value: unknown, name: string): number {
    const parsed = typeof value === 'string' && /^\d+$/u.test(value) ? Number(value) : value;
    if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed) || parsed < 1) {
        throw new AppError(`INVALID_${name.toUpperCase()}`, `${name} must be a positive integer.`, 400);
    }
    return parsed;
}

type Handler = (req: Request, res: Response) => Promise<void>;
function route(handler: Handler): (req: Request, res: Response, next: NextFunction) => void {
    return (req, res, next) => { void handler(req, res).catch(next); };
}
