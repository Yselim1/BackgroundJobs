import {JOBS_FILE, readJsonFile} from '../utils/storage.js';
import {assertValidJobDefinition, JobValidationError} from '../utils/jobValidator.js';
import { type Job } from '../types/index.js';

export class JobStore {
    async getAll(): Promise<Job[]> {
        const definitions = await readJsonFile<unknown>(JOBS_FILE);
        return definitions.map((definition, index) => {
            try {
                return assertValidJobDefinition(definition);
            } catch (error: unknown) {
                if (error instanceof JobValidationError) {
                    throw new JobValidationError(error.issues.map(issue => ({...issue,path:`jobs[${index}].` + issue.path})));
                }
                throw error;
            }
        });
    }

    async getById(jobId: string): Promise<Job | undefined> {
        const jobs = await this.getAll();

        return jobs.find(job => job.id === jobId);
    }
}