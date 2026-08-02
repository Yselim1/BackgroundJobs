import { hostname } from 'node:os';
import { JobRunner, type ExecutionObserver } from '../core/JobRunner.js';
import { AppError, ExecutionAbortError } from '../errors.js';
import { ExecutionRepository, type ClaimedExecution } from '../repositories/ExecutionRepository.js';
import { WorkerRepository } from '../repositories/WorkerRepository.js';
import type { AuthenticatedActor, ExecutionSummary, Step, StepAttemptLog, StepLog } from '../types/index.js';
import type { SecretService } from './SecretService.js';

export interface WorkerRuntimeOptions {
    repository?: WorkerRepository;
    name?: string;
    queues?: string[];
    heartbeatMs?: number;
    leaseMs?: number;
    schedulerEnabled?: boolean;
}

export class JobExecutionManager {
    private acceptingWork = false;
    private servicesStarted = false;
    private draining = false;
    private workerId: string | undefined;
    private schedulerTimer: NodeJS.Timeout | undefined;
    private dispatcherTimer: NodeJS.Timeout | undefined;
    private heartbeatTimer: NodeJS.Timeout | undefined;
    private dispatching = false;
    private readonly controllers = new Map<string, AbortController>();
    private readonly running = new Map<string, Promise<void>>();
    readonly workers: WorkerRepository;
    private readonly workerName: string;
    private readonly queues: string[];
    private readonly heartbeatMs: number;
    private readonly leaseMs: number;
    private readonly schedulerEnabled: boolean;

    constructor(
        private readonly executions: ExecutionRepository,
        private readonly runner = new JobRunner(),
        private readonly workerConcurrency = 4,
        private readonly schedulerPollMs = 1000,
        private readonly secrets?: SecretService,
        options: WorkerRuntimeOptions = {}
    ) {
        this.workers = options.repository ?? new WorkerRepository(executions.pool);
        this.workerName = options.name ?? `${hostname()}:${process.pid}`;
        this.queues = options.queues ?? ['default'];
        this.heartbeatMs = options.heartbeatMs ?? 5_000;
        this.leaseMs = options.leaseMs ?? 20_000;
        this.schedulerEnabled = options.schedulerEnabled ?? true;
    }

    get started(): boolean { return this.servicesStarted; }
    get capacity(): number { return this.workerConcurrency; }

    async start(): Promise<void> {
        if (this.acceptingWork) return;
        await this.executions.reconcileExpiredLeases();
        this.workerId = await this.workers.register(this.workerName, this.queues, this.workerConcurrency);
        this.acceptingWork = true;
        this.servicesStarted = true;
        await this.heartbeatTick();
        if (this.schedulerEnabled) await this.schedulerTick();
        await this.dispatcherTick();
    }

    async cancel(executionId: string, actor?: AuthenticatedActor): Promise<ExecutionSummary> {
        const cancellation = await this.executions.requestCancellation(executionId, actor);
        if (cancellation.shouldAbort) this.abortLocal(executionId);
        return (await this.executions.getSummary(executionId)) ?? cancellation.summary;
    }

    async shutdown(graceMs: number): Promise<void> {
        this.draining = true;
        this.acceptingWork = false;
        this.servicesStarted = false;
        if (this.schedulerTimer !== undefined) clearTimeout(this.schedulerTimer);
        if (this.dispatcherTimer !== undefined) clearTimeout(this.dispatcherTimer);
        if (this.heartbeatTimer !== undefined) clearTimeout(this.heartbeatTimer);
        const allRunning = (): Promise<void> => Promise.allSettled([...this.running.values()]).then(() => undefined);
        let graceExpired = false;
        if (this.running.size > 0) {
            await Promise.race([allRunning(), new Promise<void>(resolve => setTimeout(() => { graceExpired = true; resolve(); }, graceMs))]);
        }
        if (graceExpired) {
            for (const controller of this.controllers.values()) {
                controller.abort(new ExecutionAbortError('SERVER_INTERRUPTED', 'Server shutdown interrupted the execution.'));
            }
            await allRunning();
        }
        if (this.workerId !== undefined) await this.workers.stop(this.workerId).catch(() => undefined);
    }

    private async heartbeatTick(): Promise<void> {
        if (!this.acceptingWork || this.workerId === undefined) return;
        try {
            const heartbeat = await this.workers.heartbeat(this.workerId, this.leaseMs);
            this.draining = heartbeat.desiredState === 'draining';
            heartbeat.cancellations.forEach(id => this.abortLocal(id));
            await this.executions.reconcileExpiredLeases();
            if (!this.draining) setImmediate(() => void this.dispatcherTick());
        } catch (error: unknown) {
            console.error('[WORKER] Heartbeat failed:', error);
        } finally {
            if (this.acceptingWork) {
                this.heartbeatTimer = setTimeout(() => void this.heartbeatTick(), this.heartbeatMs);
                this.heartbeatTimer.unref();
            }
        }
    }

    private abortLocal(executionId: string): void {
        this.controllers.get(executionId)?.abort(
            new ExecutionAbortError('EXECUTION_CANCELLED', 'Execution cancellation was requested.')
        );
    }

    private async schedulerTick(): Promise<void> {
        if (!this.acceptingWork || !this.schedulerEnabled) return;
        try { await this.executions.processDueJobs(); }
        catch (error: unknown) { console.error('[SCHEDULER] Poll failed:', error); }
        finally {
            if (this.acceptingWork) {
                this.schedulerTimer = setTimeout(() => void this.schedulerTick(), this.schedulerPollMs);
                this.schedulerTimer.unref();
            }
        }
    }

    private async dispatcherTick(): Promise<void> {
        if (!this.acceptingWork || this.dispatching) return;
        this.dispatching = true;
        try {
            while (this.acceptingWork && !this.draining && this.running.size < this.workerConcurrency) {
                const claimed = await this.executions.claimOldestQueued(this.workerId!, this.queues, this.leaseMs);
                if (claimed === undefined) break;
                const controller = new AbortController();
                this.controllers.set(claimed.executionId, controller);
                const work = this.executeClaimed(claimed, controller).finally(() => {
                    this.controllers.delete(claimed.executionId);
                    this.running.delete(claimed.executionId);
                    if (this.acceptingWork && !this.draining) setImmediate(() => void this.dispatcherTick());
                });
                this.running.set(claimed.executionId, work);
            }
        } catch (error: unknown) {
            console.error('[DISPATCHER] Poll failed:', error);
        } finally {
            this.dispatching = false;
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
        const { executionId, jobDefinition, startedAt, input } = claimed;
        let timeout: NodeJS.Timeout | undefined;
        try {
            if (await this.executions.isCancellationRequested(executionId)) this.abortLocal(executionId);
            if (jobDefinition.TIMEOUT_MS !== undefined) {
                const remaining = Math.max(0, jobDefinition.TIMEOUT_MS - (Date.now() - startedAt.getTime()));
                timeout = setTimeout(() => controller.abort(
                    new ExecutionAbortError('JOB_TIMEOUT', `Job exceeded TIMEOUT_MS (${jobDefinition.TIMEOUT_MS}ms).`)
                ), remaining);
            }
            const secretValues = this.secrets === undefined ? {} : await this.secrets.resolveForJob(jobDefinition);
            const result = await this.runner.run(jobDefinition, {
                signal: controller.signal, observer: this.observerFor(executionId), input, secrets: secretValues,
                ...(claimed.stepIds === undefined ? {} : { stepIds: claimed.stepIds }),
                ...(claimed.reusedStepResults === undefined ? {} : { reusedStepResults: claimed.reusedStepResults })
            });
            const cancellationWonRace = await this.executions.isCancellationRequested(executionId);
            const status = cancellationWonRace ? 'cancelled' : result.status;
            const errorCode = cancellationWonRace ? 'EXECUTION_CANCELLED' : result.errorCode ?? null;
            const errorMessage = cancellationWonRace ? 'Execution cancellation was requested.' : result.error ?? null;
            if (status !== 'success') await this.executions.cancelUnfinishedSteps(executionId, errorMessage ?? 'Execution did not complete.');
            await this.executions.finishExecution(executionId, status, errorCode, errorMessage);
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            await this.executions.cancelUnfinishedSteps(executionId, message).catch(() => undefined);
            const errorCode = error instanceof AppError ? error.code : 'EXECUTION_PERSISTENCE_FAILED';
            await this.executions.finishExecution(executionId, 'failed', errorCode, message).catch(() => undefined);
            console.error(`[DISPATCHER] Execution ${executionId} failed outside the runner:`, error);
        } finally {
            if (timeout !== undefined) clearTimeout(timeout);
        }
    }

    private observerFor(executionId: string): ExecutionObserver {
        return {
            stepStarted: async (step: Step, startedAt: Date) => this.executions.stepStarted(executionId, step.ID, startedAt),
            attemptStarted: async (step: Step, attempt: number, startedAt: Date, itemIndex?: number) =>
                this.executions.attemptStarted(executionId, step.ID, attempt, startedAt, itemIndex),
            attemptFinished: async (step: Step, attempt: StepAttemptLog) => this.executions.attemptFinished(executionId, step.ID, attempt),
            stepFinished: async (step: StepLog) => this.executions.stepFinished(executionId, step)
        };
    }
}
