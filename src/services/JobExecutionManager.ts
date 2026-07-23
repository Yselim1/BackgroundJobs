import { randomUUID } from 'node:crypto';
import { JobRunner } from '../core/JobRunner.js';
import { JobLogStore } from '../storage/JobLogStore.js';
import { type Job, type JobLog } from '../types/index.js';

export type JobExecutionManagerErrorCode ='JOB_ALREADY_RUNNING' | 'JOB_IS_RUNNING';

export class JobExecutionManagerError extends Error {
    constructor(
        message: string,
        readonly statusCode: number,
        readonly code: JobExecutionManagerErrorCode
    ) {
        super(message);
        this.name = 'JobExecutionManagerError';
    }
}

export class JobExecutionManager {
    private readonly activeLogsById = new Map<string, JobLog>();
    private readonly activeLogIdByJobId = new Map<string, string>();

    constructor(
        private readonly jobRunner = new JobRunner(),
        private readonly jobLogStore = new JobLogStore()
    ) {}

    start(job: Job): JobLog {
        const existingLogId = this.activeLogIdByJobId.get(job.id);

        if (existingLogId !== undefined) {
            throw new JobExecutionManagerError(`Job with id ${job.id} is already running ` + `with logId ${existingLogId}.`,409,'JOB_ALREADY_RUNNING');
        }

        const logId = randomUUID();
        const startTime = new Date();

        const initialLog: JobLog = {
            logId,
            jobId: job.id,
            startTime: startTime.toISOString(),
            status: 'running',

            stepResults: Object.fromEntries([...job.STEPS].sort((firstStep, secondStep) => firstStep.ORDER - secondStep.ORDER)
                                                          .map(step => [step.ID,
                                                        {
                                                            stepId: step.ID,
                                                            stepName: step.NAME,
                                                            stepType: step.TYPE,
                                                            status: 'pending',
                                                            attempts: []
                                                        }]))
        };

        this.activeLogsById.set(logId, initialLog);
        this.activeLogIdByJobId.set(job.id, logId);

        // Deferring execution allows the HTTP request to return 202 before
        // the first potentially expensive executor starts its work.
        setImmediate(() => {
            void this.executeInBackground(job, logId, startTime);
        });

        return structuredClone(initialLog);
    
    }

    getActiveLog(logId: string): JobLog | undefined {
        const log = this.activeLogsById.get(logId);
        return log === undefined ? undefined : structuredClone(log);
    }

    getAllActiveLogs(): JobLog[] {
        return [...this.activeLogsById.values()].map(log => structuredClone(log));
    }

    isJobRunning(jobId: string): boolean {
        return this.activeLogIdByJobId.has(jobId);
    }

    private async executeInBackground(job: Job, logId: string, startTime: Date): Promise<void> {
        try {
            const finalLog = await this.jobRunner.run(job, {logId, startTime, onProgress: snapshot => {this.activeLogsById.set(logId, snapshot);}});

            await this.jobLogStore.append(finalLog);
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);

            console.error(`[JOB_EXECUTION_MANAGER] Background execution ` + `for job "${job.id}" failed: ${message}`);
        } finally {
            this.activeLogsById.delete(logId);
            this.activeLogIdByJobId.delete(job.id);
        }
    }
}

export const jobExecutionManager = new JobExecutionManager();