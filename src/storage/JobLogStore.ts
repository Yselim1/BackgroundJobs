import {readJsonFile, updateJsonFile, LOGS_FILE} from '../utils/storage.js';
import { type JobLog } from '../types/index.js';

export class JobLogStore {
    async getAll(): Promise<JobLog[]> {
        return readJsonFile<JobLog>(LOGS_FILE);
    }

    async getById(logId: string): Promise<JobLog | undefined> {
        const logs = await this.getAll();

        return logs.find(log => log.logId === logId);
    }

    async append(log: JobLog): Promise<void> {
        await updateJsonFile<JobLog, void>( LOGS_FILE, logs => {logs.push(log);});
    }
}