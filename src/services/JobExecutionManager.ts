import { JobRunner, type ExecutionObserver } from '../core/JobRunner.js';
import { ExecutionAbortError } from '../errors.js';
import { ExecutionRepository, type ClaimedExecution } from '../repositories/ExecutionRepository.js';
import type { ExecutionSummary, Step, StepAttemptLog, StepLog } from '../types/index.js';

export class JobExecutionManager {
    private acceptingWork = false;
    private servicesStarted = false;
    private schedulerTimer: NodeJS.Timeout | undefined;
    private dispatcherTimer: NodeJS.Timeout | undefined;
    private readonly controllers = new Map<string, AbortController>();
    private readonly running = new Map<string, Promise<void>>();

    constructor(
        private readonly executions: ExecutionRepository,
        private readonly runner = new JobRunner(),
        private readonly workerConcurrency = 4,
        private readonly schedulerPollMs = 1000
    ) {}

    get started(): boolean { return this.servicesStarted; }

    async start(): Promise<void> {
        if (this.acceptingWork) return;
        await this.executions.reconcileInterrupted();
        this.acceptingWork = true;
        this.servicesStarted = true;
        await this.schedulerTick();
        await this.dispatcherTick();
    }

    async cancel(executionId: string): Promise<ExecutionSummary> {
        const cancellation = await this.executions.requestCancellation(executionId);
        if (cancellation.shouldAbort) {
            this.controllers.get(executionId)?.abort(
                new ExecutionAbortError('EXECUTION_CANCELLED', 'Execution cancellation was requested.')
            );
        }
        return (await this.executions.getSummary(executionId)) ?? cancellation.summary;
    }

    async shutdown(graceMs: number): Promise<void> {
        this.acceptingWork = false;
        this.servicesStarted = false;
        if (this.schedulerTimer !== undefined) clearTimeout(this.schedulerTimer);
        if (this.dispatcherTimer !== undefined) clearTimeout(this.dispatcherTimer);
        const allRunning = (): Promise<void> => Promise.allSettled([...this.running.values()]).then(() => undefined);
        if (this.running.size === 0) return;
        let graceExpired = false;
        await Promise.race([
            allRunning(),
            new Promise<void>(resolve => setTimeout(() => { graceExpired = true; resolve(); }, graceMs))
        ]);
        if (!graceExpired) return;
        for (const controller of this.controllers.values()) {
            controller.abort(new ExecutionAbortError('SERVER_INTERRUPTED', 'Server shutdown interrupted the execution.'));
        }
        await allRunning();
    }

    private async schedulerTick(): Promise<void> {
        if (!this.acceptingWork) return;
        try {
            await this.executions.processDueJobs();
        } catch (error: unknown) {
            console.error('[SCHEDULER] Poll failed:', error);
        } finally {
            if (this.acceptingWork) {
                this.schedulerTimer = setTimeout(() => void this.schedulerTick(), this.schedulerPollMs);
                this.schedulerTimer.unref();
            }
        }
    }

    private async dispatcherTick(): Promise<void> {
        if (!this.acceptingWork) return;
        try {
            while (this.acceptingWork && this.running.size < this.workerConcurrency) {
                const claimed = await this.executions.claimOldestQueued();
                if (claimed === undefined) break;
                const controller = new AbortController();
                this.controllers.set(claimed.executionId, controller);
                const work = this.executeClaimed(claimed, controller).finally(() => {
                    this.controllers.delete(claimed.executionId);
                    this.running.delete(claimed.executionId);
                    if (this.acceptingWork) setImmediate(() => void this.dispatcherTick());
                });
                this.running.set(claimed.executionId, work);
            }
        } catch (error: unknown) {
            console.error('[DISPATCHER] Poll failed:', error);
        } finally {
            if (this.acceptingWork && this.dispatcherTimer === undefined) {
                this.dispatcherTimer = setTimeout(() => {
                    this.dispatcherTimer = undefined;
                    void this.dispatcherTick();
                }, Math.min(this.schedulerPollMs, 250));
                this.dispatcherTimer.unref();
            }
        }
    }

    private async executeClaimed(claimed: ClaimedExecution, controller: AbortController): Promise<void> {
        const { executionId, jobDefinition, startedAt } = claimed;
        let timeout: NodeJS.Timeout | undefined;
        try {
            if (await this.executions.isCancellationRequested(executionId)) {
                controller.abort(new ExecutionAbortError('EXECUTION_CANCELLED', 'Execution cancellation was requested.'));
            }
            if (jobDefinition.TIMEOUT_MS !== undefined) {
                const remaining = Math.max(0, jobDefinition.TIMEOUT_MS - (Date.now() - startedAt.getTime()));
                timeout = setTimeout(() => controller.abort(
                    new ExecutionAbortError('JOB_TIMEOUT', `Job exceeded TIMEOUT_MS (${jobDefinition.TIMEOUT_MS}ms).`)
                ), remaining);
            }
            const result = await this.runner.run(jobDefinition, {
                signal: controller.signal,
                observer: this.observerFor(executionId)
            });
            const cancellationWonRace = await this.executions.isCancellationRequested(executionId);
            const status = cancellationWonRace ? 'cancelled' : result.status;
            const errorCode = cancellationWonRace ? 'EXECUTION_CANCELLED' : result.errorCode ?? null;
            const errorMessage = cancellationWonRace ? 'Execution cancellation was requested.' : result.error ?? null;
            if (status !== 'success') {
                await this.executions.cancelUnfinishedSteps(executionId, errorMessage ?? 'Execution did not complete.');
            }
            await this.executions.finishExecution(executionId, status, errorCode, errorMessage);
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            await this.executions.cancelUnfinishedSteps(executionId, message).catch(() => undefined);
            await this.executions.finishExecution(executionId, 'failed', 'EXECUTION_PERSISTENCE_FAILED', message).catch(() => undefined);
            console.error(`[DISPATCHER] Execution ${executionId} failed outside the runner:`, error);
        } finally {
            if (timeout !== undefined) clearTimeout(timeout);
        }
    }

    private observerFor(executionId: string): ExecutionObserver {
        return {
            stepStarted: async (step: Step, startedAt: Date) => this.executions.stepStarted(executionId, step.ID, startedAt),
            attemptStarted: async (step: Step, attempt: number, startedAt: Date) =>
                this.executions.attemptStarted(executionId, step.ID, attempt, startedAt),
            attemptFinished: async (step: Step, attempt: StepAttemptLog) =>
                this.executions.attemptFinished(executionId, step.ID, attempt),
            stepFinished: async (step: StepLog) => this.executions.stepFinished(executionId, step)
        };
    }
}
