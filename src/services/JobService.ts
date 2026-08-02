import { AppError } from '../errors.js';
import { ExecutionRepository } from '../repositories/ExecutionRepository.js';
import { JobRepository } from '../repositories/JobRepository.js';
import type { AuthenticatedActor, ExecutionSummary, Job, JobExecutionPlan, JobRevision, JobRevisionSummary, JobStatus, JobValidationResult, JobView, PageResponse, Step } from '../types/index.js';
import { buildDependencyLevels } from '../utils/jobGraph.js';
import { assertValidJobDefinition, JobValidationError, validateJobDefinition } from '../utils/jobValidator.js';
import { assertValidCron, nextOccurrence } from '../utils/cron.js';

export class JobService {
    constructor(private readonly jobs: JobRepository, private readonly executions: ExecutionRepository) {}

    validateJob(input: unknown): JobValidationResult { return validateJobDefinition(input); }

    async createJob(input: unknown, actor?: AuthenticatedActor): Promise<JobView> {
        return this.jobs.create(assertValidJobDefinition(input), undefined, actor);
    }

    async replaceJob(jobId: string, input: unknown, expectedVersion: number, actor?: AuthenticatedActor): Promise<JobView> {
        const replacement = assertValidJobDefinition(input);
        if (replacement.id !== jobId) {
            throw new JobValidationError([{
                path: 'id', code: 'JOB_ID_MISMATCH',
                message: `Body job ID ${replacement.id} does not match path job ID ${jobId}.`
            }]);
        }
        return this.jobs.replace(jobId, replacement, expectedVersion, undefined, actor);
    }

    async deleteJob(jobId: string): Promise<void> { await this.jobs.delete(jobId); }

    async setJobStatuses(jobIds: string[], status: JobStatus, actor?: AuthenticatedActor): Promise<JobView[]> {
        return this.jobs.setStatuses(jobIds, status, undefined, actor);
    }

    async listJobVersions(jobId: string, page: number, limit: number): Promise<PageResponse<JobRevisionSummary>> {
        return this.jobs.listVersions(jobId, page, limit);
    }

    async getJobVersion(jobId: string, version: number): Promise<JobRevision> {
        return this.jobs.getVersion(jobId, version);
    }

    async rollbackJob(jobId: string, targetVersion: number, expectedVersion: number, actor?: AuthenticatedActor): Promise<JobView> {
        return this.jobs.rollback(jobId, targetVersion, expectedVersion, actor);
    }

    async previewSchedule(input: unknown): Promise<{
        schedule: string;
        timezone: string;
        generatedAt: string;
        occurrences: string[];
    }> {
        if (!isRecord(input)) {
            throw new AppError('INVALID_SCHEDULE_PREVIEW', 'Request body must be an object.', 422);
        }
        const unsupported = Object.keys(input).filter(key => !['schedule', 'timezone', 'count'].includes(key));
        if (unsupported.length > 0) {
            throw new AppError('INVALID_SCHEDULE_PREVIEW', `Unsupported schedule preview field: ${unsupported[0]}.`, 422);
        }
        const schedule = input.schedule;
        const timezone = input.timezone ?? 'UTC';
        const count = input.count ?? 5;
        if (typeof schedule !== 'string' || typeof timezone !== 'string') {
            throw new AppError('INVALID_SCHEDULE_PREVIEW', 'schedule and timezone must be strings.', 422);
        }
        if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > 10) {
            throw new AppError('INVALID_SCHEDULE_PREVIEW', 'count must be an integer between 1 and 10.', 422);
        }
        try {
            assertValidCron(schedule, timezone);
        } catch (error: unknown) {
            throw new AppError(
                'INVALID_SCHEDULE_PREVIEW',
                error instanceof Error ? error.message : String(error),
                422
            );
        }
        const generatedAt = (await this.jobs.pool.query<{ now: Date }>(
            'SELECT clock_timestamp() AS now'
        )).rows[0]!.now;
        const occurrences: string[] = [];
        let cursor = generatedAt;
        for (let index = 0; index < count; index++) {
            cursor = nextOccurrence(schedule, timezone, cursor);
            occurrences.push(cursor.toISOString());
        }
        return { schedule, timezone, generatedAt: generatedAt.toISOString(), occurrences };
    }

    async validateRunInput(jobId: string, input: unknown, inputProvided: boolean): Promise<{ valid: true; input: Record<string, unknown> }> {
        return this.executions.validateRunInput(jobId, input, inputProvided);
    }

    async startJob(
        jobId: string,
        input?: unknown,
        actor?: AuthenticatedActor,
        idempotencyKey?: string,
        inputProvided = input !== undefined
    ): Promise<ExecutionSummary> {
        return this.executions.enqueueManual(jobId, input, actor, {
            inputProvided,
            ...(idempotencyKey === undefined ? {} : { idempotencyKey })
        });
    }

    async testRun(
        draftInput: unknown,
        selectedStepId: string,
        input: unknown,
        inputProvided: boolean,
        actor: AuthenticatedActor
    ): Promise<ExecutionSummary> {
        return this.executions.enqueueTest(assertValidJobDefinition(draftInput), selectedStepId, input, inputProvided, actor);
    }

    async previewBackfill(jobId: string, from: Date, to: Date): ReturnType<ExecutionRepository['previewBackfill']> {
        return this.executions.previewBackfill(jobId, from, to);
    }

    async applyBackfill(
        jobId: string,
        from: Date,
        to: Date,
        input: unknown,
        inputProvided: boolean,
        actor: AuthenticatedActor,
        idempotencyKey?: string
    ): ReturnType<ExecutionRepository['applyBackfill']> {
        return this.executions.applyBackfill(jobId, from, to, input, inputProvided, actor, idempotencyKey);
    }

    async getJobWithID(id: string): Promise<JobView> {
        const job = await this.jobs.getById(id);
        if (job === undefined) throw new AppError('JOB_NOT_FOUND', `Job with id ${id} not found.`, 404);
        return job;
    }

    async getAllJobs(): Promise<JobView[]> { return this.jobs.getAll(); }

    async getExecutionPlan(jobId: string): Promise<JobExecutionPlan> {
        const view = await this.getJobWithID(jobId);
        const job = stripReadOnly(view);
        const sorted = [...job.STEPS].sort((first, second) => first.ORDER - second.ORDER);
        const byId = new Map(sorted.map(step => [step.ID, step]));
        const levels = buildDependencyLevels(sorted.map(step => ({ id: step.ID, dependsOn: step.DEPENDS_ON ?? [] })));
        return {
            jobId: job.id,
            maxConcurrency: job.MAX_CONCURRENCY ?? 10,
            failurePolicy: job.FAILURE_POLICY ?? 'fail_fast',
            levels: levels.map((ids, index) => ({
                level: index + 1,
                steps: ids.map(id => byId.get(id)).filter((step): step is Step => step !== undefined).map(step => ({
                    id: step.ID,
                    name: step.NAME,
                    type: step.TYPE,
                    order: step.ORDER,
                    dependsOn: step.DEPENDS_ON ?? [],
                    ...(step.WHEN === undefined ? {} : { when: step.WHEN }),
                    ...(step.FOREACH === undefined ? {} : { foreach: step.FOREACH })
                }))
            }))
        };
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stripReadOnly(view: JobView): Job {
    const { last_run: _last, next_run: _next, created_at: _created, updated_at: _updated, ...job } = view;
    return job;
}
