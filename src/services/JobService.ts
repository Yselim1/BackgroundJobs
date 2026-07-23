import { JobRunner } from '../core/JobRunner.js';
import { JobLogStore } from '../storage/JobLogStore.js';
import { JobStore } from '../storage/JobStore.js';
import {type Job, type JobLog, type JobValidationResult, type JobExecutionPlan, type Step} from '../types/index.js';
import {assertValidJobDefinition, JobValidationError, validateJobDefinition} from '../utils/jobValidator.js';
import { buildDependencyLevels } from '../utils/jobGraph.js';

export type JobServiceErrorCode = 'JOB_NOT_FOUND' | 'JOB_ALREADY_EXISTS';

export class JobServiceError extends Error {
    constructor(
        message: string,
        readonly statusCode: number,
        readonly code: JobServiceErrorCode
    ) {
        super(message);
        this.name = 'JobServiceError';
    }
}

export class JobService {
    constructor(
        private readonly jobRunner = new JobRunner(),
        private readonly jobLogStore = new JobLogStore(),
        private readonly jobStore = new JobStore()
    ) {}

    validateJob(input: unknown): JobValidationResult {
        return validateJobDefinition(input);
    }

    async createJob(input: unknown): Promise<Job> {
        const job = assertValidJobDefinition(input);
        const created = await this.jobStore.create(job);
        if (!created) {
            throw new JobServiceError(`Job with id ${job.id} already exists.`, 409, 'JOB_ALREADY_EXISTS');
        }
        return job;
    }

    async replaceJob(jobId: string, input: unknown): Promise<Job> {
        const replacement = assertValidJobDefinition(input);

        if (replacement.id !== jobId) {
            throw new JobValidationError([
                {
                    path: 'id',
                    code: 'JOB_ID_MISMATCH',
                    message:`Body job ID "${replacement.id}" does not ` + `match path job ID "${jobId}".`
                }
            ]);
        }

        const replaced = await this.jobStore.replace(jobId, replacement);
        if (!replaced) {
            throw new JobServiceError(`Job with id ${jobId} not found.`, 404, 'JOB_NOT_FOUND');
        }

        return replacement;
    }

    async deleteJob(jobId: string): Promise<void> {
        const deleted = await this.jobStore.deleteById(jobId);
        if (!deleted) {
            throw new JobServiceError(`Job with id ${jobId} not found.`, 404, 'JOB_NOT_FOUND');
        }
    }

    async runJob(job: Job): Promise<JobLog> {
        const log = await this.jobRunner.run(job);

        await this.jobLogStore.append(log);

        return log;
    }

    async getJobWithID(id: string): Promise<Job> {
        const job = await this.jobStore.getById(id);
        if (!job) {
            throw new JobServiceError(`Job with id ${id} not found.`, 404, 'JOB_NOT_FOUND');
        }
        return job;
    }

    async getAllJobs(): Promise<Job[]> {
        return this.jobStore.getAll();
    }

    async getExecutionPlan(jobId: string): Promise<JobExecutionPlan> {
        const job = await this.getJobWithID(jobId);

        const sortedSteps = [...job.STEPS].sort((firstStep, secondStep) => firstStep.ORDER - secondStep.ORDER);

        const stepsById = new Map(sortedSteps.map(step => [step.ID, step]));

        const dependencyLevels = buildDependencyLevels(sortedSteps.map(step => ({id: step.ID,dependsOn: step.DEPENDS_ON ?? []})));

        return {
            jobId: job.id,
            maxConcurrency: job.MAX_CONCURRENCY ?? 10,
            failurePolicy: job.FAILURE_POLICY ?? 'fail_fast',
            levels: dependencyLevels.map((stepIds, index) => {const levelSteps = stepIds.map(stepId => stepsById.get(stepId))
                .filter((step): step is Step => step !== undefined)
                .sort((firstStep, secondStep) =>firstStep.ORDER - secondStep.ORDER);
            return {
                level: index + 1,
                steps: levelSteps.map(step => ({id: step.ID, name: step.NAME, type: step.TYPE, order: step.ORDER, dependsOn: step.DEPENDS_ON ?? []}))
            };})
        };
    }

}