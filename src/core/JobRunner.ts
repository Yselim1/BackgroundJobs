import { ExecutorRegistry } from '../executors/ExecutorRegistry.js';
import { AppError, ExecutionAbortError, abortError, throwIfAborted, toError } from '../errors.js';
import type {
    Job,
    JobRunResult,
    RetryBackoff,
    RetryPolicy,
    Step,
    StepAttemptLog,
    StepLog
} from '../types/index.js';
import { assertValidJobDefinition } from '../utils/jobValidator.js';
import { normalizeJsonOutput } from '../utils/jsonOutput.js';
import { ConcurrencyLimiter } from '../utils/ConcurrencyLimiter.js';
import { evaluateWorkflowCondition, resolveFanOutItems } from '../utils/workflowExpressions.js';
import { redactManagedSecretError, redactManagedSecrets } from '../security/redaction.js';

interface ResolvedRetryPolicy { MAX_ATTEMPTS: number; DELAY_MS: number; BACKOFF: RetryBackoff; }
interface StepExecutionResult { stepId: string; output: unknown; }
type BatchStepResult =
    | { step: Step; status: 'fulfilled'; value: StepExecutionResult }
    | { step: Step; status: 'rejected'; reason: Error };

export interface ExecutionObserver {
    stepStarted(step: Step, startedAt: Date): Promise<void>;
    attemptStarted(step: Step, attempt: number, startedAt: Date, itemIndex?: number): Promise<void>;
    attemptFinished(step: Step, attempt: StepAttemptLog, itemIndex?: number): Promise<void>;
    stepFinished(step: StepLog): Promise<void>;
}

const NOOP_OBSERVER: ExecutionObserver = {
    stepStarted: async () => undefined,
    attemptStarted: async () => undefined,
    attemptFinished: async () => undefined,
    stepFinished: async () => undefined
};

export interface JobRunOptions {
    signal?: AbortSignal;
    observer?: ExecutionObserver;
    input?: Record<string, unknown>;
    secrets?: Record<string, string>;
}

export class JobRunner {
    async run(job: Job, options: JobRunOptions = {}): Promise<JobRunResult> {
        const signal = options.signal ?? new AbortController().signal;
        const observer = options.observer ?? NOOP_OBSERVER;
        const stepResults: Record<string, StepLog> = {};
        const pendingSteps = new Map<string, Step>();
        const successfulSteps = new Set<string>();
        const unsuccessfulSteps = new Set<string>();

        try {
            const executableJob = assertValidJobDefinition(job);
            const steps = [...executableJob.STEPS].sort((first, second) => first.ORDER - second.ORDER);
            for (const step of steps) {
                pendingSteps.set(step.ID, step);
                stepResults[step.ID] = baseStepLog(step, 'pending');
            }
            const failurePolicy = executableJob.FAILURE_POLICY ?? 'fail_fast';
            const maxConcurrency = executableJob.MAX_CONCURRENCY ?? 10;
            const limiter = new ConcurrencyLimiter(maxConcurrency);
            const context: Record<string, unknown> = {
                input: options.input ?? {},
                secrets: options.secrets ?? {}
            };
            let representativeFailure: Error | undefined;

            while (pendingSteps.size > 0) {
                throwIfAborted(signal);
                await this.skipDependencyBlocked(pendingSteps, unsuccessfulSteps, stepResults, observer);
                if (pendingSteps.size === 0) break;
                const runnable = [...pendingSteps.values()].filter(step =>
                    (step.DEPENDS_ON ?? []).every(dependency => successfulSteps.has(dependency))
                );
                if (runnable.length === 0) {
                    throw new Error(`Circular or unresolved dependency detected. Remaining steps: ${[...pendingSteps.keys()].join(', ')}`);
                }
                const batch = await this.runStepsWithConcurrency(
                    runnable,
                    maxConcurrency,
                    step => this.executeStep(
                        step,
                        context,
                        executableJob.DEFAULT_STEP_RETRY,
                        maxConcurrency,
                        limiter,
                        signal,
                        observer,
                        stepResults
                    ),
                    step => failurePolicy === 'fail_fast' || step.FAIL_JOB_ON_FAILURE === true
                );
                for (const result of batch.results) {
                    pendingSteps.delete(result.step.ID);
                    if (result.status === 'fulfilled') {
                        context[result.value.stepId] = result.value.output;
                        successfulSteps.add(result.value.stepId);
                    } else {
                        unsuccessfulSteps.add(result.step.ID);
                        representativeFailure ??= result.reason;
                    }
                }
                if (signal.aborted) throw abortError(signal);
                if (batch.stopReason !== undefined) {
                    await this.cancelPending(pendingSteps, unsuccessfulSteps, stepResults, observer,
                        `Job cancelled by failure policy: ${batch.stopReason.message}`);
                    throw batch.stopReason;
                }
            }
            if (representativeFailure !== undefined) throw representativeFailure;
            return { status: 'success', stepResults };
        } catch (error: unknown) {
            const resolved = signal.aborted ? abortError(signal) : toError(error);
            if (resolved instanceof ExecutionAbortError) {
                await this.cancelPending(pendingSteps, unsuccessfulSteps, stepResults, observer, resolved.message);
                return compactResult({
                    status: resolved.code === 'EXECUTION_CANCELLED' ? 'cancelled' : 'failed',
                    errorCode: resolved.code,
                    error: resolved.message,
                    stepResults
                });
            }
            await this.cancelPending(pendingSteps, unsuccessfulSteps, stepResults, observer,
                `Job cancelled after failure: ${resolved.message}`);
            return compactResult({
                status: 'failed',
                errorCode: resolved instanceof AppError ? resolved.code : 'JOB_FAILED',
                error: buildJobError(stepResults, resolved),
                stepResults
            });
        }
    }

    private async executeStep(
        step: Step,
        context: Record<string, unknown>,
        defaultRetry: RetryPolicy | undefined,
        maxConcurrency: number,
        limiter: ConcurrencyLimiter,
        signal: AbortSignal,
        observer: ExecutionObserver,
        stepResults: Record<string, StepLog>
    ): Promise<StepExecutionResult> {
        throwIfAborted(signal);
        if (!(await this.conditionAllowsStep(step, context, observer, stepResults))) {
            return { stepId: step.ID, output: null };
        }
        const startedAt = new Date();
        const attempts: StepAttemptLog[] = [];
        stepResults[step.ID] = { ...baseStepLog(step, 'running'), startedAt: startedAt.toISOString(), attempts };
        await observer.stepStarted(step, startedAt);
        try {
            const output = step.FOREACH === undefined
                ? await this.executeWithRetry(step, context, defaultRetry, limiter, signal, observer, attempts)
                : await this.executeFanOut(
                    step,
                    context,
                    defaultRetry,
                    maxConcurrency,
                    limiter,
                    signal,
                    observer,
                    attempts
                );
            sortAttempts(attempts);
            const finishedAt = new Date();
            const result: StepLog = {
                ...baseStepLog(step, 'success'),
                startedAt: startedAt.toISOString(),
                finishedAt: finishedAt.toISOString(),
                durationMs: finishedAt.getTime() - startedAt.getTime(),
                attempts,
                output
            };
            stepResults[step.ID] = result;
            await observer.stepFinished(result);
            return { stepId: step.ID, output };
        } catch (error: unknown) {
            const resolved = signal.aborted ? abortError(signal) : toError(error);
            sortAttempts(attempts);
            const finishedAt = new Date();
            const aborted = resolved instanceof ExecutionAbortError;
            const interrupted = resolved instanceof ExecutionAbortError && resolved.code === 'SERVER_INTERRUPTED';
            const result: StepLog = compactStep({
                ...baseStepLog(step, aborted && !interrupted ? 'cancelled' : 'failed'),
                startedAt: startedAt.toISOString(),
                finishedAt: finishedAt.toISOString(),
                durationMs: finishedAt.getTime() - startedAt.getTime(),
                attempts,
                errorCode: resolved instanceof AppError || resolved instanceof ExecutionAbortError ? resolved.code : 'STEP_FAILED',
                ...(aborted && !interrupted ? { reason: resolved.message } : { error: resolved.message })
            });
            stepResults[step.ID] = result;
            await observer.stepFinished(result);
            throw resolved;
        }
    }

    private async conditionAllowsStep(
        step: Step,
        context: Record<string, unknown>,
        observer: ExecutionObserver,
        stepResults: Record<string, StepLog>
    ): Promise<boolean> {
        if (step.WHEN === undefined) return true;
        try {
            if (evaluateWorkflowCondition(step.WHEN, context)) return true;
            const result = await terminalUnstartedStep(
                step,
                'skipped',
                `Condition ${step.WHEN.PATH} evaluated to false.`,
                observer
            );
            stepResults[step.ID] = result;
            return false;
        } catch (error: unknown) {
            const resolved = toError(error);
            const result: StepLog = {
                ...baseStepLog(step, 'failed'),
                finishedAt: new Date().toISOString(),
                errorCode: resolved instanceof AppError ? resolved.code : 'CONDITION_EVALUATION_FAILED',
                error: resolved.message
            };
            stepResults[step.ID] = result;
            await observer.stepFinished(result);
            throw resolved;
        }
    }

    private async executeFanOut(
        step: Step,
        context: Record<string, unknown>,
        defaultRetry: RetryPolicy | undefined,
        maxConcurrency: number,
        limiter: ConcurrencyLimiter,
        signal: AbortSignal,
        observer: ExecutionObserver,
        attempts: StepAttemptLog[]
    ): Promise<unknown[]> {
        const definition = step.FOREACH!;
        const items = resolveFanOutItems(definition.ITEMS, context);
        if (items.length === 0) return [];
        const results: unknown[] = new Array(items.length);
        const errors: Array<Error | undefined> = new Array(items.length);
        let nextIndex = 0;
        const worker = async (): Promise<void> => {
            while (true) {
                throwIfAborted(signal);
                const itemIndex = nextIndex++;
                if (itemIndex >= items.length) return;
                const itemContext: Record<string, unknown> = {
                    ...context,
                    item: items[itemIndex],
                    index: itemIndex
                };
                try {
                    results[itemIndex] = await this.executeWithRetry(
                        step,
                        itemContext,
                        defaultRetry,
                        limiter,
                        signal,
                        observer,
                        attempts,
                        itemIndex
                    );
                } catch (error: unknown) {
                    errors[itemIndex] = toError(error);
                }
            }
        };
        const fanOutConcurrency = Math.min(
            items.length,
            definition.MAX_CONCURRENCY ?? maxConcurrency,
            maxConcurrency
        );
        const workers = await Promise.allSettled(
            Array.from({ length: fanOutConcurrency }, () => worker())
        );
        if (signal.aborted) throw abortError(signal);
        const rejectedWorker = workers.find(
            (result): result is PromiseRejectedResult => result.status === 'rejected'
        );
        if (rejectedWorker !== undefined) throw toError(rejectedWorker.reason);
        const failedIndex = errors.findIndex(error => error !== undefined);
        if (failedIndex >= 0) {
            const failure = errors[failedIndex]!;
            throw new AppError('FOREACH_ITEM_FAILED', `Fan-out item ${failedIndex} failed: ${failure.message}`);
        }
        return results;
    }

    private async executeWithRetry(
        step: Step,
        context: Record<string, unknown>,
        defaultRetry: RetryPolicy | undefined,
        limiter: ConcurrencyLimiter,
        signal: AbortSignal,
        observer: ExecutionObserver,
        attempts: StepAttemptLog[],
        itemIndex?: number
    ): Promise<unknown> {
        const executor = ExecutorRegistry.getExecutor(step.TYPE);
        const retry = resolveRetry(defaultRetry, step.RETRY);
        let lastError: Error | undefined;
        for (let attemptNumber = 1; attemptNumber <= retry.MAX_ATTEMPTS; attemptNumber++) {
            throwIfAborted(signal);
            const startedAt = new Date();
            await observer.attemptStarted(step, attemptNumber, startedAt, itemIndex);
            try {
                const rawOutput = await limiter.run(signal, () => executor.execute(step, context, { signal }));
                throwIfAborted(signal);
                const output = redactManagedSecrets(
                    normalizeJsonOutput(rawOutput),
                    contextSecrets(context)
                );
                const finishedAt = new Date();
                const attempt: StepAttemptLog = {
                    attempt: attemptNumber,
                    ...(itemIndex === undefined ? {} : { itemIndex }),
                    status: 'success',
                    startedAt: startedAt.toISOString(),
                    finishedAt: finishedAt.toISOString(),
                    durationMs: finishedAt.getTime() - startedAt.getTime()
                };
                attempts.push(attempt);
                await observer.attemptFinished(step, attempt, itemIndex);
                return output;
            } catch (error: unknown) {
                const resolved = signal.aborted
                    ? abortError(signal)
                    : redactManagedSecretError(toError(error), contextSecrets(context));
                const finishedAt = new Date();
                const cancelled = resolved instanceof ExecutionAbortError;
                const attempt: StepAttemptLog = {
                    attempt: attemptNumber,
                    ...(itemIndex === undefined ? {} : { itemIndex }),
                    status: cancelled ? 'cancelled' : 'failed',
                    startedAt: startedAt.toISOString(),
                    finishedAt: finishedAt.toISOString(),
                    durationMs: finishedAt.getTime() - startedAt.getTime(),
                    errorCode: resolved instanceof AppError || resolved instanceof ExecutionAbortError ? resolved.code : 'STEP_ATTEMPT_FAILED',
                    error: resolved.message
                };
                attempts.push(attempt);
                await observer.attemptFinished(step, attempt, itemIndex);
                if (cancelled) throw resolved;
                lastError = resolved;
                if (attemptNumber < retry.MAX_ATTEMPTS) {
                    await abortableDelay(calculateDelay(retry, attemptNumber), signal);
                }
            }
        }
        throw lastError ?? new Error(`Step ${step.NAME} failed without returning an error.`);
    }

    private async runStepsWithConcurrency(
        steps: Step[],
        maxConcurrency: number,
        task: (step: Step) => Promise<StepExecutionResult>,
        shouldStop: (step: Step) => boolean
    ): Promise<{ results: BatchStepResult[]; stopReason?: Error }> {
        const results: Array<BatchStepResult | undefined> = new Array(steps.length);
        let index = 0;
        let stopReason: Error | undefined;
        const worker = async (): Promise<void> => {
            while (stopReason === undefined) {
                const current = index++;
                const step = steps[current];
                if (step === undefined) return;
                try {
                    results[current] = { step, status: 'fulfilled', value: await task(step) };
                } catch (error: unknown) {
                    const reason = toError(error);
                    results[current] = { step, status: 'rejected', reason };
                    if (shouldStop(step)) stopReason ??= reason;
                }
            }
        };
        await Promise.all(Array.from({ length: Math.min(maxConcurrency, steps.length) }, () => worker()));
        return { results: results.filter((item): item is BatchStepResult => item !== undefined), ...(stopReason === undefined ? {} : { stopReason }) };
    }

    private async skipDependencyBlocked(
        pending: Map<string, Step>,
        unsuccessful: Set<string>,
        results: Record<string, StepLog>,
        observer: ExecutionObserver
    ): Promise<void> {
        let changed: boolean;
        do {
            changed = false;
            for (const [stepId, step] of [...pending]) {
                const blockers = (step.DEPENDS_ON ?? []).filter(dependency => unsuccessful.has(dependency));
                if (blockers.length === 0) continue;
                const result = await terminalUnstartedStep(step, 'skipped', `Dependencies did not succeed: ${blockers.join(', ')}`, observer);
                results[stepId] = result;
                pending.delete(stepId);
                unsuccessful.add(stepId);
                changed = true;
            }
        } while (changed);
    }

    private async cancelPending(
        pending: Map<string, Step>,
        unsuccessful: Set<string>,
        results: Record<string, StepLog>,
        observer: ExecutionObserver,
        reason: string
    ): Promise<void> {
        for (const [stepId, step] of [...pending]) {
            const current = results[stepId];
            if (current?.status === 'running') continue;
            const result = await terminalUnstartedStep(step, 'cancelled', reason, observer);
            results[stepId] = result;
            unsuccessful.add(stepId);
            pending.delete(stepId);
        }
    }
}

function contextSecrets(context: Record<string, unknown>): Record<string, string> {
    const value = context.secrets;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
            .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    );
}

function resolveRetry(defaultPolicy?: RetryPolicy, stepPolicy?: RetryPolicy): ResolvedRetryPolicy {
    return { MAX_ATTEMPTS: 1, DELAY_MS: 1000, BACKOFF: 'fixed', ...defaultPolicy, ...stepPolicy };
}

function calculateDelay(retry: ResolvedRetryPolicy, attempt: number): number {
    return retry.BACKOFF === 'exponential' ? retry.DELAY_MS * 2 ** (attempt - 1) : retry.DELAY_MS;
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
        const onAbort = (): void => { clearTimeout(timer); reject(abortError(signal)); };
        signal.addEventListener('abort', onAbort, { once: true });
    });
}

function baseStepLog(step: Step, status: StepLog['status']): StepLog {
    return { stepId: step.ID, stepName: step.NAME, stepType: step.TYPE, status, attempts: [] };
}

function sortAttempts(attempts: StepAttemptLog[]): void {
    attempts.sort((left, right) =>
        (left.itemIndex ?? -1) - (right.itemIndex ?? -1) || left.attempt - right.attempt
    );
}

async function terminalUnstartedStep(
    step: Step,
    status: 'skipped' | 'cancelled',
    reason: string,
    observer: ExecutionObserver
): Promise<StepLog> {
    const result: StepLog = {
        ...baseStepLog(step, status),
        finishedAt: new Date().toISOString(),
        reason
    };
    await observer.stepFinished(result);
    return result;
}

function compactStep(value: StepLog): StepLog {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as unknown as StepLog;
}

function compactResult(value: JobRunResult): JobRunResult {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as unknown as JobRunResult;
}

function buildJobError(results: Record<string, StepLog>, fallback: Error): string {
    const failed = Object.values(results).filter(result => result.status === 'failed');
    if (failed.length === 0) return fallback.message;
    if (failed.length === 1) return `Step ${failed[0]!.stepName} (${failed[0]!.stepId}) failed: ${failed[0]!.error ?? fallback.message}`;
    return `${failed.length} steps failed. See stepResults for details.`;
}
