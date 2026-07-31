import { describe, expect, it } from 'vitest';
import { JobRunner } from '../../src/core/JobRunner.js';
import { defineExecutorPlugin, registerExecutorPlugin } from '../../src/sdk/index.js';
import type { Job, StepAttemptLog } from '../../src/types/index.js';
import { validateJobDefinition } from '../../src/utils/jobValidator.js';
import { evaluateWorkflowCondition, resolveFanOutItems } from '../../src/utils/workflowExpressions.js';

describe('conditional workflows', () => {
    it('skips a false condition while satisfying downstream dependencies', async () => {
        const result = await new JobRunner().run({
            ...baseJob(),
            STEPS: [
                {
                    ORDER: 1,
                    ID: 'optional',
                    NAME: 'Optional',
                    TYPE: 'SCRIPT',
                    WHEN: { PATH: 'input.enabled' },
                    STEP_PARAMS: { CODE: '() => ({ shouldNotRun: true })' }
                },
                {
                    ORDER: 2,
                    ID: 'after',
                    NAME: 'After',
                    TYPE: 'SCRIPT',
                    DEPENDS_ON: ['optional'],
                    STEP_PARAMS: { CODE: 'context => ({ optionalWasSkipped: context.optional === null })' }
                }
            ]
        }, { input: { enabled: false } });

        expect(result.status).toBe('success');
        expect(result.stepResults.optional?.status).toBe('skipped');
        expect(result.stepResults.after?.output).toEqual({ optionalWasSkipped: true });
    });

    it('evaluates explicit operators and rejects non-array fan-out sources', () => {
        expect(evaluateWorkflowCondition(
            { PATH: 'input.count', OPERATOR: 'greater_than', VALUE: 2 },
            { input: { count: 3 } }
        )).toBe(true);
        expect(evaluateWorkflowCondition(
            { PATH: 'input.missing', OPERATOR: 'not_exists' },
            { input: {} }
        )).toBe(true);
        expect(() => resolveFanOutItems('input.items', { input: { items: 'not-an-array' } }))
            .toThrowError(/must resolve to an array/u);
    });
});

describe('fan-out and executor plugins', () => {
    it('runs fan-out items in order without exceeding job concurrency', async () => {
        let active = 0;
        let maximumActive = 0;
        const unregister = registerExecutorPlugin(defineExecutorPlugin({
            type: 'test_map',
            executor: {
                execute: async (_step, context) => {
                    active++;
                    maximumActive = Math.max(maximumActive, active);
                    await new Promise(resolve => setTimeout(resolve, 15));
                    active--;
                    return Number(context.item) * 2;
                }
            }
        }));
        const attempts: StepAttemptLog[] = [];
        try {
            const result = await new JobRunner().run({
                ...baseJob(),
                MAX_CONCURRENCY: 2,
                STEPS: [{
                    ORDER: 1,
                    ID: 'map',
                    NAME: 'Map',
                    TYPE: 'TEST_MAP',
                    FOREACH: { ITEMS: 'input.items', MAX_CONCURRENCY: 8 },
                    STEP_PARAMS: {}
                }]
            }, {
                input: { items: [3, 1, 2, 4] },
                observer: {
                    stepStarted: async () => undefined,
                    attemptStarted: async () => undefined,
                    attemptFinished: async (_step, attempt) => { attempts.push(attempt); },
                    stepFinished: async () => undefined
                }
            });
            expect(result.status).toBe('success');
            expect(result.stepResults.map?.output).toEqual([6, 2, 4, 8]);
            expect(result.stepResults.map?.attempts.map(attempt => attempt.itemIndex)).toEqual([0, 1, 2, 3]);
            expect(attempts).toHaveLength(4);
            expect(maximumActive).toBe(2);
        } finally {
            unregister();
        }
    });

    it('runs plugin validation through the normal job validator', () => {
        const unregister = registerExecutorPlugin(defineExecutorPlugin({
            type: 'validated_plugin',
            executor: { execute: async () => null },
            validate: (params, path) => typeof params.MESSAGE === 'string'
                ? []
                : [{ path: path + '.MESSAGE', code: 'MESSAGE_REQUIRED', message: 'MESSAGE must be a string.' }]
        }));
        try {
            const result = validateJobDefinition({
                ...baseJob(),
                STEPS: [{ ORDER: 1, ID: 'custom', NAME: 'Custom', TYPE: 'VALIDATED_PLUGIN', STEP_PARAMS: {} }]
            });
            expect(result.valid).toBe(false);
            if (!result.valid) expect(result.errors).toContainEqual({
                path: 'STEPS[0].STEP_PARAMS.MESSAGE',
                code: 'MESSAGE_REQUIRED',
                message: 'MESSAGE must be a string.'
            });
        } finally {
            unregister();
        }
    });

    it('waits for in-flight fan-out items to settle on cancellation', async () => {
        const unregister = registerExecutorPlugin(defineExecutorPlugin({
            type: 'abortable_map',
            executor: {
                execute: async (_step, _context, { signal }) => new Promise((_resolve, reject) => {
                    const onAbort = () => reject(signal.reason);
                    signal.addEventListener('abort', onAbort, { once: true });
                })
            }
        }));
        const controller = new AbortController();
        try {
            const run = new JobRunner().run({
                ...baseJob(),
                MAX_CONCURRENCY: 2,
                STEPS: [{
                    ORDER: 1,
                    ID: 'map',
                    NAME: 'Map',
                    TYPE: 'ABORTABLE_MAP',
                    FOREACH: { ITEMS: 'input.items' },
                    STEP_PARAMS: {}
                }]
            }, { input: { items: [1, 2, 3] }, signal: controller.signal });
            setTimeout(() => controller.abort(new Error('stop fan-out')), 20);
            const result = await run;
            expect(result.status).toBe('cancelled');
            expect(result.stepResults.map?.status).toBe('cancelled');
            expect(result.stepResults.map?.attempts).toHaveLength(2);
            expect(result.stepResults.map?.attempts.every(attempt => attempt.status === 'cancelled')).toBe(true);
        } finally {
            unregister();
        }
    });
});

describe('workflow validation', () => {
    it('requires workflow paths to reference input or direct dependencies', () => {
        const result = validateJobDefinition({
            ...baseJob(),
            STEPS: [
                { ORDER: 1, ID: 'source', NAME: 'Source', TYPE: 'SCRIPT', STEP_PARAMS: { CODE: '() => []' } },
                {
                    ORDER: 2,
                    ID: 'consumer',
                    NAME: 'Consumer',
                    TYPE: 'SCRIPT',
                    FOREACH: { ITEMS: 'source.items' },
                    STEP_PARAMS: { CODE: '() => null' }
                }
            ]
        });
        expect(result.valid).toBe(false);
        if (!result.valid) {
            expect(result.errors.map(error => error.code)).toContain('WORKFLOW_SOURCE_NOT_DEPENDENCY');
        }
    });
});

function baseJob(): Job {
    return {
        id: 'platform-job',
        name: 'Platform job',
        status: 'inactive',
        timezone: 'UTC',
        STEPS: [{ ORDER: 1, ID: 'only', NAME: 'Only', TYPE: 'SCRIPT', STEP_PARAMS: { CODE: '() => null' } }]
    };
}
