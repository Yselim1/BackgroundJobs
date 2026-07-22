import {JOBS_FILE,readJsonFile,updateJsonFile} from '../utils/storage.js';
import {assertValidJobDefinition, JobValidationError} from '../utils/jobValidator.js';
import { type Job } from '../types/index.js';

export class JobStore {
    async getAll(): Promise<Job[]> {
        const definitions = await readJsonFile<unknown>(JOBS_FILE);
        return this.normalizeDefinitions(definitions);
    }

    async getById(jobId: string): Promise<Job | undefined> {
        const jobs = await this.getAll();

        return jobs.find(job => job.id === jobId);
    }

    async create(job: Job): Promise<boolean> {
        return updateJsonFile<unknown, boolean>(JOBS_FILE, definitions => {
            const jobs = this.normalizeDefinitions(definitions);
            if (jobs.some(existing => existing.id === job.id)) {
                return false;
            }

            jobs.push(job);

            this.replaceDefinitions(definitions, jobs);
            return true;
        });
    }

    async replace(jobId: string, replacement: Job): Promise<boolean> {
        return updateJsonFile<unknown, boolean>(JOBS_FILE,definitions => {
            const jobs = this.normalizeDefinitions(definitions);

            const jobIndex = jobs.findIndex(job => job.id === jobId);

            if (jobIndex === -1) return false;

            jobs[jobIndex] = replacement;

            this.replaceDefinitions(definitions, jobs);
            return true;
        });
    }

    async deleteById(jobId: string): Promise<boolean> {
        return updateJsonFile<unknown, boolean>(JOBS_FILE,definitions => {
            const jobs = this.normalizeDefinitions(definitions);

            const jobIndex = jobs.findIndex(job => job.id === jobId);
            
            if (jobIndex === -1) return false;

            jobs.splice(jobIndex, 1);

            this.replaceDefinitions(definitions, jobs);

            return true;
        });
    }

    private normalizeDefinitions(definitions: unknown[]): Job[] {
        return definitions.map((definition, index) => {
            try {
                return assertValidJobDefinition(definition);
                } catch (error: unknown) {
                    if (error instanceof JobValidationError) {
                        throw new JobValidationError(error.issues.map(issue => ({...issue,path:`jobs[${index}].` + issue.path})));
                    }
                    throw error;
                }});
    }

    private replaceDefinitions(definitions: unknown[], jobs: readonly Job[]): void {
        definitions.splice(0, definitions.length, ...jobs);
    }
}