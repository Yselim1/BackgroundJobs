import { describe, expect, it } from 'vitest';
import { JobRunner, type ExecutionObserver } from '../../src/core/JobRunner.js';
import { ExecutionAbortError } from '../../src/errors.js';
import type { Job, Step, StepAttemptLog, StepLog } from '../../src/types/index.js';

const noopObserver: ExecutionObserver = {
    stepStarted: async () => undefined,
    attemptStarted: async () => undefined,
    attemptFinished: async () => undefined,
    stepFinished: async () => undefined
};

describe('JobRunner execution control', () => {
    it('cancels an abortable retry delay without starting another attempt', async () => {
        const controller = new AbortController();
        const attempts: StepAttemptLog[] = [];
        const observer: ExecutionObserver = {
            ...noopObserver,
            attemptFinished: async (_step: Step, attempt: StepAttemptLog) => {
                attempts.push(attempt);
                controller.abort(new ExecutionAbortError('EXECUTION_CANCELLED', 'cancelled in retry delay'));
            }
        };
        const started = Date.now();
        const result = await new JobRunner().run(scriptJob({
            CODE: `() => { throw new Error('temporary'); }`
        }, { MAX_ATTEMPTS: 3, DELAY_MS: 5000 }), { signal: controller.signal, observer });
        expect(result.status).toBe('cancelled');
        expect(result.errorCode).toBe('EXECUTION_CANCELLED');
        expect(attempts).toHaveLength(1);
        expect(Date.now() - started).toBeLessThan(1000);
    });

    it('classifies an execution deadline as JOB_TIMEOUT', async () => {
        const controller = new AbortController();
        const observer: ExecutionObserver = {
            ...noopObserver,
            attemptFinished: async () => {
                controller.abort(new ExecutionAbortError('JOB_TIMEOUT', 'job deadline exceeded'));
            }
        };
        const result = await new JobRunner().run(scriptJob({
            CODE: `() => { throw new Error('temporary'); }`
        }, { MAX_ATTEMPTS: 2, DELAY_MS: 5000 }), { signal: controller.signal, observer });
        expect(result.status).toBe('failed');
        expect(result.errorCode).toBe('JOB_TIMEOUT');
        expect(result.stepResults.only?.status).toBe('cancelled');
    });

    it('fails a step whose output cannot be persisted', async () => {
        const result = await new JobRunner().run(scriptJob({ CODE: `() => 1n` }), { observer: noopObserver });
        expect(result.status).toBe('failed');
        expect(result.errorCode).toBe('OUTPUT_NOT_SERIALIZABLE');
        expect(result.stepResults.only?.errorCode).toBe('OUTPUT_NOT_SERIALIZABLE');
    });
});

function scriptJob(params: Record<string, unknown>, retry?: Job['DEFAULT_STEP_RETRY']): Job {
    return {
        id: 'unit-job',
        name: 'Unit job',
        status: 'active',
        timezone: 'UTC',
        ...(retry === undefined ? {} : { DEFAULT_STEP_RETRY: retry }),
        STEPS: [{ ORDER: 1, ID: 'only', NAME: 'Only step', TYPE: 'SCRIPT', STEP_PARAMS: params }]
    };
}
