import { AppError } from '../errors.js';
import { ExecutionRepository } from '../repositories/ExecutionRepository.js';
import { JobRepository } from '../repositories/JobRepository.js';
import type { ExecutionSummary, Job, JobExecutionPlan, JobValidationResult, JobView, Step } from '../types/index.js';
import { buildDependencyLevels } from '../utils/jobGraph.js';
import { normalizeExecutionInput } from '../utils/executionInput.js';
import { assertValidJobDefinition, JobValidationError, validateJobDefinition } from '../utils/jobValidator.js';

export class JobService {
    constructor(private readonly jobs: JobRepository, private readonly executions: ExecutionRepository) {}

    validateJob(input: unknown): JobValidationResult { return validateJobDefinition(input); }

    async createJob(input: unknown): Promise<JobView> {
        return this.jobs.create(assertValidJobDefinition(input));
    }

    async replaceJob(jobId: string, input: unknown): Promise<JobView> {
        const replacement = assertValidJobDefinition(input);
        if (replacement.id !== jobId) {
            throw new JobValidationError([{
                path: 'id', code: 'JOB_ID_MISMATCH',
                message: `Body job ID ${replacement.id} does not match path job ID ${jobId}.`
            }]);
        }
        return this.jobs.replace(jobId, replacement);
    }

    async deleteJob(jobId: string): Promise<void> { await this.jobs.delete(jobId); }

    async startJob(jobId: string, input?: unknown): Promise<ExecutionSummary> {
        return this.executions.enqueueManual(jobId, normalizeExecutionInput(input));
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
                    id: step.ID, name: step.NAME, type: step.TYPE, order: step.ORDER, dependsOn: step.DEPENDS_ON ?? []
                }))
            }))
        };
    }
}

function stripReadOnly(view: JobView): Job {
    const { last_run: _last, next_run: _next, created_at: _created, updated_at: _updated, ...job } = view;
    return job;
}
