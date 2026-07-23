import { randomUUID } from 'node:crypto';
import { ExecutorRegistry } from '../executors/ExecutorRegistry.js';
import { type Job, type Step, type JobLog, type RetryPolicy, type RetryBackoff, type StepAttemptLog, type FailurePolicy } from '../types/index.js';
import { assertValidJobDefinition } from '../utils/jobValidator.js';

type StepExecutionResult = {
    stepId: string;
    output: any;
};

type ResolvedRetryPolicy = {
    MAX_ATTEMPTS: number;
    DELAY_MS: number;
    BACKOFF: RetryBackoff;
};

type BatchStepResult =
    | {
        step: Step;
        status: 'fulfilled';
        value: StepExecutionResult;
    }
    | {
        step: Step;
        status: 'rejected';
        reason: Error;
    };

type BatchExecutionResult =
    | {
        results: BatchStepResult[];
        stopRequested: false;
    }
    | {
        results: BatchStepResult[];
        stopRequested: true;
        stopReason: Error;
    };

export type JobProgressCallback = (jobLog: JobLog) => void

export interface JobRunOptions {
    logId?: string;
    startTime?: Date;
    onProgress?: JobProgressCallback;
}

export class JobRunner {
    
    async run(job: Job, options: JobRunOptions = {}): Promise<JobLog> {
        const jobStartTime = options.startTime ? new Date(options.startTime.getTime()) : new Date();

        const jobLog: JobLog = {
            logId: options.logId ?? randomUUID(),
            jobId: job.id,
            startTime: jobStartTime.toISOString(),
            status: 'running',
            stepResults: {}
        };

        try {
            const executableJob = assertValidJobDefinition(job);
            jobLog.jobId = executableJob.id;
            if (!executableJob.STEPS || executableJob.STEPS.length === 0) {
                throw new Error(`Job "${executableJob.id}" has no STEPS to execute.`);
            }

            const steps = [...executableJob.STEPS].sort((a, b) => a.ORDER - b.ORDER);

            const failurePolicy = this.resolveFailurePolicy(executableJob.FAILURE_POLICY);
            const maxConcurrency = this.resolveMaxConcurrency(executableJob.MAX_CONCURRENCY);

            const context: Record<string, any> = {};
            const pendingSteps = new Map<string, Step>();
            
            const successfulSteps = new Set<string>();
            const unsuccessfulSteps = new Set<string>();

            let representativeFailure: Error | undefined;

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
            this.emitProgress(jobLog, options.onProgress);

            while (pendingSteps.size > 0) {
                
                // A step cannot be executed if it has a failed, skipped, or cancelled dependency 
                // mark these steps as skipped 
                this.markDependencyBlockedStepsAsSkipped(
                    pendingSteps,
                    unsuccessfulSteps,
                    jobLog,
                    options.onProgress
                )

                if (pendingSteps.size === 0) {
                    break;
                }

                // başka bir adıma bağlı olmayan ya da tüm bağlılıkları bitmiş adımların listesini al
                const runnableSteps = [...pendingSteps.values()].filter(step => {
                    const dependencies = step.DEPENDS_ON ?? [];
                    return dependencies.every(dependency => successfulSteps.has(dependency));
                });

                // bekleyen adımlar var ama hiçbiri çalıştırılamıyor, 
                // döngüsel bağımlılık veya çözülmemiş bağımlılıklar olabilir
                if (runnableSteps.length === 0) {
                    const remainingSteps = [...pendingSteps.keys()].join(', ');

                    throw new Error(
                        `Circular or unresolved dependency detected. Remaining steps: ${remainingSteps}`
                    );
                }
                

                const batchResult = await this.runStepsWithConcurrency(
                    runnableSteps,
                    maxConcurrency,
                    step => this.executeStep(
                        step,
                        context,
                        jobLog,
                        executableJob.DEFAULT_STEP_RETRY,
                        options.onProgress
                    ),
                    step => this.shouldStopJobAfterFailure(step, failurePolicy)
                );

                for (const result of batchResult.results) {
                    pendingSteps.delete(result.step.ID);

                    if (result.status === 'fulfilled') {
                        const { stepId, output } = result.value;

                        context[stepId] = output;
                        successfulSteps.add(stepId);
                        continue;
                    }

                    unsuccessfulSteps.add(result.step.ID);
                    representativeFailure ??= result.reason;
                }

                if (batchResult.stopRequested) {
                    const reason = batchResult.stopReason;

                    this.cancelPendingSteps(
                        pendingSteps,
                        unsuccessfulSteps,
                        jobLog,
                        `Job cancelled by failure policy: ${reason.message}`,
                        options.onProgress
                    );

                    throw reason;
                }
            }

            // continue_independent allows independent work to finish, but the job
            // still ends as failed if any step exhausted all retry attempts.
            if (representativeFailure) {
                throw representativeFailure;
            }

            const jobEndTime = new Date();

            jobLog.status = 'success';
            jobLog.endTime = jobEndTime.toISOString();
            jobLog.durationMs = jobEndTime.getTime() - jobStartTime.getTime();

            this.emitProgress(jobLog, options.onProgress);

            return jobLog;
        } catch (error: unknown) {
            const jobEndTime = new Date();
            const resolvedError = this.toError(error);

            jobLog.status = 'failed';
            jobLog.endTime = jobEndTime.toISOString();
            jobLog.durationMs = jobEndTime.getTime() - jobStartTime.getTime();
            jobLog.error = this.buildJobErrorMessage(jobLog, resolvedError);

            this.emitProgress(jobLog, options.onProgress);

            return jobLog;
        }
    }

    private async executeStep(
        step: Step,
        context: Record<string, any>,
        jobLog: JobLog,
        defaultStepRetry?: RetryPolicy,
        onProgress?: JobProgressCallback
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
        
        this.emitProgress(jobLog, onProgress);

        try {
            console.log(`[JOB_RUNNER] Starting step "${step.NAME}"`);

            const output = await this.executeStepWithRetry(
                step,
                context,
                jobLog,
                defaultStepRetry,
                onProgress
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

            this.emitProgress(jobLog, onProgress);

            console.log(`[JOB_RUNNER] Step "${step.NAME}" completed`);

            return {
                stepId: step.ID,
                output
            };
        } catch (error: unknown) {
            const stepEndTime = new Date();
            const resolvedError = this.toError(error);
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
                error: resolvedError.message
            };

            this.emitProgress(jobLog, onProgress);

            console.error(`[JOB_RUNNER] Step "${step.NAME}" failed`, resolvedError);

            throw new Error(`Step "${step.NAME}" failed: ${resolvedError.message}`);
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
        task: (step: Step) => Promise<StepExecutionResult>,
        shouldStopAfterFailure: (step: Step) => boolean
    ): Promise<BatchExecutionResult> {
        const results: Array<BatchStepResult | undefined> = new Array(steps.length);
        let currentIndex = 0;
        let stopRequested = false;
        let stopReason: Error | undefined;

        const worker = async (): Promise<void> => {
            while (true) {
                // Do not take another step after a fail-fast condition occurs.
                // Steps that were already running are allowed to finish.
                if (stopRequested) {
                    return;
                }

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

                    results[index] = {
                        step,
                        status: 'fulfilled',
                        value
                    };
                } catch (error: unknown) {
                    const resolvedError = this.toError(error);

                    results[index] = {
                        step,
                        status: 'rejected',
                        reason: resolvedError
                    };

                    // This is evaluated only after executeStepWithRetry has used all
                    // remaining attempts. A temporary attempt failure does not stop
                    // the job.
                    if (shouldStopAfterFailure(step)) {
                        stopRequested = true;
                        stopReason ??= resolvedError;
                    }
                }
            }
        };

        const workerCount = Math.min(maxConcurrency, steps.length);

        await Promise.all(
            Array.from({ length: workerCount }, () => worker())
        );

        const filteredResults = results.filter((result): result is BatchStepResult => result !== undefined);

        if (stopRequested) {
            return {
                results: filteredResults,
                stopRequested: true,
                stopReason: stopReason ?? new Error(
                    'Job stop was requested without a recorded failure.'
                )
            };
        }

        return {
            results: filteredResults,
            stopRequested: false
        };
    }

    private async executeStepWithRetry(
        step: Step,
        context: Record<string, any>,
        jobLog: JobLog,
        defaultStepRetry?: RetryPolicy,
        onProgress?: JobProgressCallback
    ): Promise<any> {
        const executor = ExecutorRegistry.getExecutor(step.TYPE);

        const retryPolicy = this.resolveStepRetryPolicy(
            defaultStepRetry,
            step.RETRY
        );

        let lastError: Error | undefined;

        const maxAttempts  = retryPolicy?.MAX_ATTEMPTS ?? 0;
        const retryDelayMs = retryPolicy?.DELAY_MS ?? 1000;
        const retryBackoff = retryPolicy?.BACKOFF ?? 'fixed';

        for (let attempt = 1; attempt <= retryPolicy.MAX_ATTEMPTS ; attempt++) {
            const attemptStartTime = new Date();

            try {
                console.log(
                    `[JOB_RUNNER] Step "${step.NAME}" attempt ${attempt}/${retryPolicy.MAX_ATTEMPTS}`
                );

                const output = await executor.execute(step, context);

                const attemptEndTime = new Date();

                this.addStepAttemptLog(jobLog, step, {
                    attempt,
                    status: 'success',
                    startedAt: attemptStartTime.toISOString(),
                    finishedAt: attemptEndTime.toISOString(),
                    durationMs: attemptEndTime.getTime() - attemptStartTime.getTime()
                    },
                    onProgress
                );

                return output;
            } catch (error: unknown) {
                lastError = this.toError(error);

                const attemptEndTime = new Date();

                this.addStepAttemptLog(jobLog, step, {
                    attempt,
                    status: 'failed',
                    startedAt: attemptStartTime.toISOString(),
                    finishedAt: attemptEndTime.toISOString(),
                    durationMs: attemptEndTime.getTime() - attemptStartTime.getTime(),
                    error: lastError.message
                    },
                    onProgress
                );

                const isLastAttempt = attempt === retryPolicy.MAX_ATTEMPTS;

                if (isLastAttempt) {
                    break;
                }

                const delayMs = this.calculateRetryDelay(
                    retryPolicy.DELAY_MS,
                    retryPolicy.BACKOFF,
                    attempt
                );

                console.warn(
                    `[JOB_RUNNER] Step "${step.NAME}" attempt ${attempt} failed: ${lastError.message}. Retrying in ${delayMs}ms...`
                );

                await this.sleep(delayMs);
            }
        }

        throw lastError ?? new Error(
            `Step "${step.NAME}" failed without returning an error.`
        );
    }

    private resolveStepRetryPolicy(
        defaultPolicy?: RetryPolicy,
        stepPolicy?: RetryPolicy
    ): ResolvedRetryPolicy {
        const policy: ResolvedRetryPolicy = {
            MAX_ATTEMPTS: 1,
            DELAY_MS: 1000,
            BACKOFF: 'fixed',
            ...(defaultPolicy ?? {}),
            ...(stepPolicy ?? {})
        };

        if (
            !Number.isInteger(policy.MAX_ATTEMPTS) ||
            policy.MAX_ATTEMPTS < 1
        ) {
            throw new Error(
                'Retry MAX_ATTEMPTS must be an integer greater than or equal to 1.'
            );
        }

        if (
            !Number.isFinite(policy.DELAY_MS) ||
            policy.DELAY_MS < 0
        ) {
            throw new Error(
                'Retry DELAY_MS must be a non-negative finite number.'
            );
        }

        if (policy.BACKOFF !== 'fixed' && policy.BACKOFF !== 'exponential') {
            throw new Error(
                `Unsupported retry BACKOFF value: ${String(policy.BACKOFF)}`
            );
        }

        return policy;
    }
    private resolveFailurePolicy(policy?: FailurePolicy): FailurePolicy {
        if (policy === undefined) {
            return 'fail_fast';
        }

        if (policy !== 'fail_fast' && policy !== 'continue_independent') {
            throw new Error(`Unsupported FAILURE_POLICY value: ${String(policy)}`);
        }

        return policy;
    }

    private shouldStopJobAfterFailure(
        step: Step,
        jobFailurePolicy: FailurePolicy
    ): boolean {
        return (
            jobFailurePolicy === 'fail_fast' ||
            step.FAIL_JOB_ON_FAILURE === true
        );
    }

    private markDependencyBlockedStepsAsSkipped(
        pendingSteps: Map<string, Step>,
        unsuccessfulSteps: Set<string>,
        jobLog: JobLog,
        onProgress?: JobProgressCallback
    ): void {
        let changed: boolean;

        do {
            changed = false;

            for (const [stepId, step] of [...pendingSteps.entries()]) {
                const blockingDependencies = (step.DEPENDS_ON ?? []).filter(
                    dependency => unsuccessfulSteps.has(dependency)
                );

                if (blockingDependencies.length === 0) {
                    continue;
                }

                this.markStepAsSkipped(
                    jobLog,
                    step,
                    `Skipped because dependencies did not succeed: ${blockingDependencies.join(', ')}`,
                    onProgress
                );

                pendingSteps.delete(stepId);
                unsuccessfulSteps.add(stepId);
                changed = true;
            }
        } while (changed);
    }

    private cancelPendingSteps(
        pendingSteps: Map<string, Step>,
        unsuccessfulSteps: Set<string>,
        jobLog: JobLog,
        reason: string,
        onProgress?: JobProgressCallback
    ): void {
        for (const [stepId, step] of pendingSteps) {
            this.markStepAsCancelled(jobLog, step, reason, onProgress);
            unsuccessfulSteps.add(stepId);
        }

        pendingSteps.clear();
    }

    private markStepAsSkipped(
        jobLog: JobLog,
        step: Step,
        reason: string,
        onProgress?: JobProgressCallback
    ): void {
        const currentStepLog = jobLog.stepResults[step.ID];
        const now = new Date();

        jobLog.stepResults[step.ID] = {
            ...currentStepLog,
            stepId: step.ID,
            stepName: step.NAME,
            stepType: step.TYPE,
            status: 'skipped',
            finishedAt: now.toISOString(),
            attempts: currentStepLog?.attempts ?? [],
            reason
        };

        this.emitProgress(jobLog, onProgress);
    }

    private markStepAsCancelled(
        jobLog: JobLog,
        step: Step,
        reason: string,
        onProgress?: JobProgressCallback
    ): void {
        const currentStepLog = jobLog.stepResults[step.ID];
        const now = new Date();

        jobLog.stepResults[step.ID] = {
            ...currentStepLog,
            stepId: step.ID,
            stepName: step.NAME,
            stepType: step.TYPE,
            status: 'cancelled',
            finishedAt: now.toISOString(),
            attempts: currentStepLog?.attempts ?? [],
            reason
        };

        this.emitProgress(jobLog, onProgress);
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

    private addStepAttemptLog(
        jobLog: JobLog,
        step: Step,
        attemptLog: StepAttemptLog,
        onProgress?: JobProgressCallback
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
            this.emitProgress(jobLog, onProgress);    
            return;
        }

        jobLog.stepResults[step.ID] = {
            ...currentStepLog,
            attempts: [
                ...(currentStepLog.attempts ?? []),
                attemptLog
            ]
        };
        this.emitProgress(jobLog, onProgress);
    }
    
    private toError(error: unknown): Error {
        if (error instanceof Error) {
            return error;
        }

        return new Error(String(error));
    }

    private buildJobErrorMessage(jobLog: JobLog, fallbackError: Error): string {
      const failedSteps = Object.values(jobLog.stepResults).filter(stepResult => stepResult.status === 'failed');

      if (failedSteps.length === 0) {
          return fallbackError.message;
      }

      if (failedSteps.length === 1) {
          const failedStep = failedSteps[0];

          if (!failedStep) {
              return fallbackError.message;
          }

          return (`Step "${failedStep.stepName}" ` + `(${failedStep.stepId}) failed: ` + `${failedStep.error ?? fallbackError.message}`);
      }
      const displayedSteps = failedSteps.slice(0, 5);

      const stepSummary = displayedSteps.map(step => `"${step.stepName}" (${step.stepId})`).join(', ');

      const remainingCount = failedSteps.length - displayedSteps.length;

      const remainingSummary = remainingCount > 0 ? `, and ${remainingCount} more` : '';

      return (`${failedSteps.length} steps failed: ` + `${stepSummary}${remainingSummary}. ` + 'See stepResults for details.');
    }

    private emitProgress(jobLog: JobLog, onProgress?: JobProgressCallback): void {
      if (!onProgress) return;

      try {
        onProgress(structuredClone(jobLog));
      } catch (error: unknown) {
        const resolvedError = this.toError(error);

        console.error('[JOB_RUNNER] Progress callback failed:', resolvedError);
      }
    }
}