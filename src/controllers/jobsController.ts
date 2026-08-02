import { Router, type NextFunction, type Request, type Response } from 'express';
import { AppError } from '../errors.js';
import { JobService } from '../services/JobService.js';
import { requirePermission } from '../security/middleware.js';
import type { JobStatus } from '../types/index.js';
import { parseIdempotencyKey } from '../utils/idempotency.js';

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
    router.post('/test-run', requirePermission('jobs:write'), route(async (req, res) => {
        const request = parseTestRun(req.body);
        const execution = await jobService.testRun(request.job, request.stepId, request.input, request.inputProvided, req.auth!);
        res.status(202).location(`/api/executions/${execution.executionId}`).json(execution);
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
    router.post('/:id/run/validate', requirePermission('jobs:run'), route(async (req, res) => {
        const request = parseRunInput(req.body);
        res.status(200).json(await jobService.validateRunInput(req.params.id as string, request.input, request.inputProvided));
    }));
    router.post('/:id/backfills/preview', requirePermission('jobs:run'), route(async (req, res) => {
        const range = parseBackfill(req.body, false);
        res.status(200).json(await jobService.previewBackfill(req.params.id as string, range.from, range.to));
    }));
    router.post('/:id/backfills', requirePermission('jobs:run'), route(async (req, res) => {
        const request = parseBackfill(req.body, true);
        const result = await jobService.applyBackfill(
            req.params.id as string, request.from, request.to, request.input, request.inputProvided,
            req.auth!, parseIdempotencyKey(req.get('Idempotency-Key'))
        );
        res.status(202).json(result);
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
        const request = parseRunInput(req.body);
        const execution = await jobService.startJob(
            req.params.id as string, request.input, req.auth,
            parseIdempotencyKey(req.get('Idempotency-Key')), request.inputProvided
        );
        res.status(202).location(`/api/executions/${execution.executionId}`).json({
            executionId: execution.executionId,
            logId: execution.executionId,
            jobId: execution.jobId,
            trigger: execution.trigger,
            status: execution.status,
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

function parseRunInput(body: unknown): { input: unknown; inputProvided: boolean } {
    if (body === undefined) return { input: undefined, inputProvided: false };
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        throw new AppError('INVALID_RUN_REQUEST', 'Request body must be an object containing an optional input object.', 422);
    }
    const record = body as Record<string, unknown>;
    const unsupported = Object.keys(record).filter(key => key !== 'input');
    if (unsupported.length > 0) {
        throw new AppError('INVALID_RUN_REQUEST', `Unsupported run request field: ${unsupported[0]}.`, 422);
    }
    return { input: record.input, inputProvided: Object.hasOwn(record, 'input') };
}

function parseTestRun(body: unknown): { job: unknown; stepId: string; input: unknown; inputProvided: boolean } {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        throw new AppError('INVALID_TEST_RUN', 'Request body must be an object.', 422);
    }
    const record = body as Record<string, unknown>;
    const unsupported = Object.keys(record).filter(key => !['job', 'stepId', 'input'].includes(key));
    if (unsupported.length > 0) throw new AppError('INVALID_TEST_RUN', `Unsupported test-run field: ${unsupported[0]}.`, 422);
    if (typeof record.stepId !== 'string' || record.stepId.trim().length === 0) {
        throw new AppError('INVALID_TEST_RUN', 'stepId must be a non-empty string.', 422);
    }
    return { job: record.job, stepId: record.stepId.trim(), input: record.input, inputProvided: Object.hasOwn(record, 'input') };
}

function parseBackfill(body: unknown, allowInput: boolean): { from: Date; to: Date; input: unknown; inputProvided: boolean } {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        throw new AppError('INVALID_BACKFILL', 'Request body must be an object.', 422);
    }
    const record = body as Record<string, unknown>;
    const allowed = allowInput ? ['from', 'to', 'input'] : ['from', 'to'];
    const unsupported = Object.keys(record).filter(key => !allowed.includes(key));
    if (unsupported.length > 0) throw new AppError('INVALID_BACKFILL', `Unsupported backfill field: ${unsupported[0]}.`, 422);
    const from = parseIsoDate(record.from, 'from');
    const to = parseIsoDate(record.to, 'to');
    if (from >= to) throw new AppError('INVALID_BACKFILL_RANGE', 'from must be earlier than to.', 422);
    return { from, to, input: record.input, inputProvided: allowInput && Object.hasOwn(record, 'input') };
}

function parseIsoDate(value: unknown, name: string): Date {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/u.test(value) || Number.isNaN(Date.parse(value))) {
        throw new AppError('INVALID_BACKFILL_RANGE', `${name} must be an ISO-8601 timestamp.`, 422);
    }
    return new Date(value);
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
