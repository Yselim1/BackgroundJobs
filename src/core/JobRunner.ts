import { randomUUID } from 'node:crypto';
import { ExecutorRegistry } from '../executors/ExecutorRegistry.js';
import { type Job, type Step, type JobLog, type RetryPolicy, type RetryBackoff, type StepAttemptLog } from '../types/index.js';

type StepExecutionResult = {
    stepId: string;
    output: any;
};

export class JobRunner {
    
    async run(job: Job): Promise<JobLog> {
        const jobStartTime = new Date();

        const jobLog: JobLog = {
            logId: randomUUID(),
            jobId: job.id,
            startTime: jobStartTime.toISOString(),
            status: 'running',
            stepResults: {}
        };

        try {
            if (!job.STEPS || job.STEPS.length === 0) {
                throw new Error(`Job "${job.id}" has no STEPS to execute.`);
            }

            const steps = [...job.STEPS].sort((a, b) => a.ORDER - b.ORDER);

            this.validateSteps(steps);

            const context: Record<string, any> = {};
            const pendingSteps = new Map<string, Step>();
            const completedSteps = new Set<string>();

            for (const step of steps) {
                pendingSteps.set(step.ID, step);

                jobLog.stepResults[step.ID] = {
                    stepId: step.ID,    
                    stepName: step.NAME,
                    stepType: step.TYPE,
                    status: 'pending',
                    attempts: []
                };
            }
            const maxConcurrency = this.resolveMaxConcurrency(job.MAX_CONCURRENCY);

            while (pendingSteps.size > 0) {
                // başka bir adıma bağlı olmayan ya da tüm bağlılıkları bitmiş adımların listesini al
                const runnableSteps = [...pendingSteps.values()].filter(step => {
                    const dependencies = step.DEPENDS_ON ?? [];
                    return dependencies.every(dependency => completedSteps.has(dependency));
                });

                // bekleyen adımlar var ama hiçbiri çalıştırılamıyor, 
                // döngüsel bağımlılık veya çözülmemiş bağımlılıklar olabilir
                if (runnableSteps.length === 0) {
                    const remainingSteps = [...pendingSteps.keys()].join(', ');

                    throw new Error(
                        `Circular or unresolved dependency detected. Remaining steps: ${remainingSteps}`
                    );
                }
                /*// tüm çalıştırılabilir adımları paralel olarak çalıştır
                const batchResults = await Promise.allSettled(
                    runnableSteps.map(step => this.executeStep(step, context, jobLog, job.DEFAULT_RETRY))
                );*/

                const batchResults = await this.runStepsWithConcurrency(runnableSteps, maxConcurrency,
                    step => this.executeStep(step, context, jobLog, job.DEFAULT_RETRY)
                );

                for (const result of batchResults) {
                    if (result.status === 'fulfilled') {
                        const { stepId, output } = result.value;

                        context[stepId] = output;
                        completedSteps.add(stepId);
                        pendingSteps.delete(stepId);
                    }
                }
                // eğer herhangi bir adım başarısız olduysa tüm iş failler
                const failedResult = batchResults.find(
                    result => result.status === 'rejected'
                );

                if (failedResult && failedResult.status === 'rejected') {
                    throw failedResult.reason;
                }
            }

            const jobEndTime = new Date();

            jobLog.status = 'success';
            jobLog.endTime = jobEndTime.toISOString();
            jobLog.durationMs = jobEndTime.getTime() - jobStartTime.getTime();

            return jobLog;
        } catch (error: any) {
            const jobEndTime = new Date();

            jobLog.status = 'failed';
            jobLog.endTime = jobEndTime.toISOString();
            jobLog.durationMs = jobEndTime.getTime() - jobStartTime.getTime();
            jobLog.error = error.message;

            return jobLog;
        }
    }

    private async executeStep(
        step: Step,
        context: Record<string, any>,
        jobLog: JobLog,
        defaultRetry?: RetryPolicy
    ): Promise<StepExecutionResult> {
        const stepStartTime = new Date();

        const existingAttempts = jobLog.stepResults[step.ID]?.attempts ?? [];

        jobLog.stepResults[step.ID] = {
            stepId: step.ID,
            stepName: step.NAME,
            stepType: step.TYPE,
            status: 'running',
            startedAt: stepStartTime.toISOString(),
            attempts: existingAttempts
        };

        try {
            console.log(`[JOB_RUNNER] Starting step "${step.NAME}"`);

            const output = await this.executeStepWithRetry(
                step,
                context,
                jobLog,
                defaultRetry
            );

            const stepEndTime = new Date();

            const attempts = jobLog.stepResults[step.ID]?.attempts ?? [];

            jobLog.stepResults[step.ID] = {
                stepId: step.ID,
                stepName: step.NAME,
                stepType: step.TYPE,
                status: 'success',
                startedAt: stepStartTime.toISOString(),
                finishedAt: stepEndTime.toISOString(),
                durationMs: stepEndTime.getTime() - stepStartTime.getTime(),
                attempts,
                output
            };

            console.log(`[JOB_RUNNER] Step "${step.NAME}" completed`);

            return {
                stepId: step.ID,
                output
            };
        } catch (error: any) {
            const stepEndTime = new Date();

            const attempts = jobLog.stepResults[step.ID]?.attempts ?? [];

            jobLog.stepResults[step.ID] = {
                stepId: step.ID,
                stepName: step.NAME,
                stepType: step.TYPE,
                status: 'failed',
                startedAt: stepStartTime.toISOString(),
                finishedAt: stepEndTime.toISOString(),
                durationMs: stepEndTime.getTime() - stepStartTime.getTime(),
                attempts,
                error: error.message
            };

            console.error(`[JOB_RUNNER] Step "${step.NAME}" failed`, error);

            throw new Error(`Step "${step.NAME}" failed: ${error.message}`);
        }
    }

    private resolveMaxConcurrency(maxConcurrency?: number): number {
        const defaultMaxConcurrency = 10;

        if (
            maxConcurrency === undefined ||
            !Number.isFinite(maxConcurrency) ||
            maxConcurrency < 1
        ) {
            return defaultMaxConcurrency;
        }

        return Math.floor(maxConcurrency);
    }

    private async runStepsWithConcurrency(
        steps: Step[],
        maxConcurrency: number,
        task: (step: Step) => Promise<StepExecutionResult>
    ): Promise<PromiseSettledResult<StepExecutionResult>[]> {
        const results: PromiseSettledResult<StepExecutionResult>[] = [];
        let currentIndex = 0;

        const worker = async (): Promise<void> => {
            while (true) {
                const index = currentIndex;
                currentIndex++;

                if (index >= steps.length) {
                    return;
                }

                const step = steps[index];

                if (!step) {
                    return;
                }

                try {
                    const value = await task(step);

                    results.push({
                        status: 'fulfilled',
                        value
                    });
                } catch (error) {
                    results.push({
                        status: 'rejected',
                        reason: error
                    });
                }
            }
        };

        const workerCount = Math.min(maxConcurrency, steps.length);

        await Promise.all(
            Array.from({ length: workerCount }, () => worker())
        );

        return results;
    }

    private async executeStepWithRetry(
        step: Step,
        context: Record<string, any>,
        jobLog: JobLog,
        defaultRetry?: RetryPolicy
    ): Promise<any> {
        const executor = ExecutorRegistry.getExecutor(step.TYPE);

        const retryPolicy = step.RETRY ?? defaultRetry;

        const retryCount = retryPolicy?.COUNT ?? 0;
        const retryDelayMs = retryPolicy?.DELAY_MS ?? 1000;
        const retryBackoff = retryPolicy?.BACKOFF ?? 'fixed';

        const totalAttempts = retryCount + 1;

        let lastError: any;

        for (let attempt = 1; attempt <= totalAttempts; attempt++) {
            const attemptStartTime = new Date();

            try {
                console.log(
                    `[JOB_RUNNER] Step "${step.NAME}" attempt ${attempt}/${totalAttempts}`
                );

                const output = await executor.execute(step, context);

                const attemptEndTime = new Date();

                this.addStepAttemptLog(jobLog, step, {
                    attempt,
                    status: 'success',
                    startedAt: attemptStartTime.toISOString(),
                    finishedAt: attemptEndTime.toISOString(),
                    durationMs: attemptEndTime.getTime() - attemptStartTime.getTime()
                });

                return output;
            } catch (error: any) {
                lastError = error;

                const attemptEndTime = new Date();

                this.addStepAttemptLog(jobLog, step, {
                    attempt,
                    status: 'failed',
                    startedAt: attemptStartTime.toISOString(),
                    finishedAt: attemptEndTime.toISOString(),
                    durationMs: attemptEndTime.getTime() - attemptStartTime.getTime(),
                    error: error.message
                });

                const isLastAttempt = attempt === totalAttempts;

                if (isLastAttempt) {
                    break;
                }

                const delayMs = this.calculateRetryDelay(
                    retryDelayMs,
                    retryBackoff,
                    attempt
                );

                console.warn(
                    `[JOB_RUNNER] Step "${step.NAME}" attempt ${attempt} failed: ${error.message}. Retrying in ${delayMs}ms...`
                );

                await this.sleep(delayMs);
            }
        }

        throw lastError;
    }

    private calculateRetryDelay(
        baseDelayMs: number,
        backoff: RetryBackoff,
        attempt: number
    ): number {
        if (backoff === 'exponential') {
            return baseDelayMs * Math.pow(2, attempt - 1);
        }

        return baseDelayMs;
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    private validateSteps(steps: Step[]): void {
        const stepIds = new Set<string>();

        for (const step of steps) {
            if (!step.ID) {
                throw new Error('Step validation failed: ID is required.');
            }

            if (!step.TYPE) {
                throw new Error(`Step "${step.ID}" validation failed: TYPE is required.`);
            }

            if (stepIds.has(step.ID)) {
                throw new Error(`Duplicate step ID found: "${step.ID}".`);
            }

            stepIds.add(step.ID);
        }

        for (const step of steps) {
            const dependencies = step.DEPENDS_ON ?? [];

            for (const dependency of dependencies) {
                if (!stepIds.has(dependency)) {
                    throw new Error(
                        `Step "${step.ID}" depends on missing step "${dependency}".`
                    );
                }

                if (dependency === step.ID) {
                    throw new Error(
                        `Step "${step.ID}" cannot depend on itself.`
                    );
                }
            }
        }
    }


    private addStepAttemptLog(
        jobLog: JobLog,
        step: Step,
        attemptLog: StepAttemptLog
    ): void {
        const currentStepLog = jobLog.stepResults[step.ID];

        if (!currentStepLog) {
            jobLog.stepResults[step.ID] = {
                stepId: step.ID,
                stepName: step.NAME,
                stepType: step.TYPE,
                status: 'running',
                attempts: [attemptLog]
            };

            return;
        }

        jobLog.stepResults[step.ID] = {
            ...currentStepLog,
            attempts: [
                ...(currentStepLog.attempts ?? []),
                attemptLog
            ]
        };
    }

}