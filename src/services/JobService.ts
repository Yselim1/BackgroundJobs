import { JobRunner } from '../core/JobRunner.js';
import { JobLogStore } from '../storage/JobLogStore.js';
import { JobStore } from '../storage/JobStore.js';
import {type Job, type JobLog} from '../types/index.js';

export class JobService {
    constructor(
        private readonly jobRunner = new JobRunner(),
        private readonly jobLogStore = new JobLogStore(),
        private readonly jobStore = new JobStore()
    ) {}

    async runJob(job: Job): Promise<JobLog> {
        const log = await this.jobRunner.run(job);

        await this.jobLogStore.append(log);

        return log;
    }

    async getJobWithID(id: string): Promise<Job> {
        const job = await this.jobStore.getById(id);
        if (!job) {
            const error = new Error(`Job with id ${id} not found.`) as Error & {statusCode: number;};
            error.statusCode = 404;
            throw error;
        }
        return job;
    }

    async getAllJobs(): Promise<Job[]> {
        return this.jobStore.getAll();
    }
    
}