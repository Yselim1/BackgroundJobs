import { JobRunner } from '../core/JobRunner.js';
import { JobLogStore } from '../storage/JobLogStore.js';
import { readJsonFile, JOBS_FILE } from '../utils/storage.js';
import { type Job, type JobLog } from '../types/index.js';

export class JobService {
    constructor(
        private readonly jobRunner = new JobRunner(),
        private readonly jobLogStore = new JobLogStore()
    ) {}

    async runJob(job: Job): Promise<JobLog> {
        const log = await this.jobRunner.run(job);

        await this.jobLogStore.append(log);

        return log;
    }

    async getJobWithID(id: string): Promise<Job> {
        const jobs = await readJsonFile<Job>(JOBS_FILE);
        const job = jobs.find(j => j.id === id);

        if (!job) {
            const error = new Error(`Job with id ${id} not found.`) as any;
            error.statusCode = 404; 
            throw error;
        }
        return job;
    }

    async getAllJobs(): Promise<Job[]> {
        return await readJsonFile<Job>(JOBS_FILE);
    }
}