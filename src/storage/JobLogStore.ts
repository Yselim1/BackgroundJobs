import { readJsonFile, writeJsonFile, LOGS_FILE } from '../utils/storage.js';
import { type JobLog } from '../types/index.js';

export class JobLogStore {
    async getAll(): Promise<JobLog[]> {
        return await readJsonFile<JobLog>(LOGS_FILE);
    }

    async getById(logId: string): Promise<JobLog | undefined> {
        const logs = await this.getAll();
        return logs.find(log => log.logId === logId);
    }

    async append(log: JobLog): Promise<void> {
        const logs = await this.getAll();
        logs.push(log);
        await writeJsonFile(LOGS_FILE, logs);
    }
}