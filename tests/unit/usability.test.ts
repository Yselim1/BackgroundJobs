import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { JobRunner } from '../../src/core/JobRunner.js';
import type { Job } from '../../src/types/index.js';
import { resolveContextTemplates } from '../../src/utils/contextResolver.js';
import { normalizeExecutionInput } from '../../src/utils/executionInput.js';
import { validateJobDefinition } from '../../src/utils/jobValidator.js';
import { createWebhookSignature } from '../../src/services/WebhookDispatcher.js';

describe('runtime input', () => {
    it('normalizes JSON objects and makes input available to steps', async () => {
        const input = normalizeExecutionInput({ account: { id: 42 } });
        const result = await new JobRunner().run(job({
            CODE: 'context => ({ accountId: context.input.account.id })'
        }), { input });
        expect(result.status).toBe('success');
        expect(result.stepResults.only?.output).toEqual({ accountId: 42 });
    });

    it('allows input templates without declaring a step dependency', () => {
        expect(resolveContextTemplates(
            { url: 'https://example.test/users/{{input.userId}}', body: '{{input.profile}}' },
            { input: { userId: 7, profile: { active: true } } },
            { allowedStepIds: new Set() }
        )).toEqual({
            url: 'https://example.test/users/7',
            body: { active: true }
        });
    });

    it('rejects non-object and non-serializable input', () => {
        expect(() => normalizeExecutionInput([])).toThrowError(/input must be a JSON object/u);
        expect(() => normalizeExecutionInput({ id: 1n })).toThrowError(/JSON-serializable/u);
    });
});

describe('webhook definitions and signatures', () => {
    it('validates webhook URLs/events and reserves the input context root', () => {
        const valid = validateJobDefinition({
            ...job({ CODE: '() => null' }),
            WEBHOOKS: [{ URL: ' https://example.test/hook ', EVENTS: ['success', 'failed'] }]
        });
        expect(valid.valid).toBe(true);
        if (valid.valid) expect(valid.job.WEBHOOKS?.[0]?.URL).toBe('https://example.test/hook');

        const invalid = validateJobDefinition({
            ...job({ CODE: '() => null' }),
            WEBHOOKS: [{ URL: 'file:///tmp/hook', EVENTS: ['running'] }],
            STEPS: [{ ORDER: 1, ID: 'input', NAME: 'Reserved', TYPE: 'SCRIPT', STEP_PARAMS: { CODE: '() => null' } }]
        });
        expect(invalid.valid).toBe(false);
        if (!invalid.valid) {
            expect(invalid.errors.map(error => error.code)).toEqual(expect.arrayContaining([
                'RESERVED_STEP_ID', 'INVALID_WEBHOOK_URL', 'INVALID_WEBHOOK_EVENT'
            ]));
        }
    });

    it('signs the timestamp and exact request body with HMAC-SHA256', () => {
        const expected = `sha256=${createHmac('sha256', 'key').update('123.{ok:true}').digest('hex')}`;
        expect(createWebhookSignature('key', '123', '{ok:true}')).toBe(expected);
    });
});

function job(params: Record<string, unknown>): Job {
    return {
        id: 'usability-job',
        name: 'Usability job',
        status: 'inactive',
        timezone: 'UTC',
        STEPS: [{ ORDER: 1, ID: 'only', NAME: 'Only', TYPE: 'SCRIPT', STEP_PARAMS: params }]
    };
}
