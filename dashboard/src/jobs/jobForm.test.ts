import { describe, expect, it } from 'vitest';
import type { Job } from '../types';
import {
    buildJobDefinition,
    createJobForm,
    JobFormError,
    stripJobReadOnly
} from './jobForm';

describe('job editor forms', () => {
    it('builds a normalized definition from structured fields', () => {
        const form = createJobForm();
        form.id = 'hello';
        form.name = 'Hello';
        form.schedule = '*/10 * * * * *';
        form.retryMaxAttempts = '3';
        form.steps[0]!.id = 'say';
        form.steps[0]!.name = 'Say hello';
        const definition = buildJobDefinition(form);
        expect(definition).toMatchObject({
            id: 'hello',
            status: 'inactive',
            schedule: '*/10 * * * * *',
            DEFAULT_STEP_RETRY: { MAX_ATTEMPTS: 3, BACKOFF: 'fixed' },
            STEPS: [{
                ORDER: 1,
                ID: 'say',
                TYPE: 'SCRIPT',
                STEP_PARAMS: { CODE: `() => ({ message: 'Hello from Workline' })` }
            }]
        });
    });

    it('preserves advanced job and step fields while removing response metadata', () => {
        const job = {
            id: 'advanced',
            version: 1,
            name: 'Advanced',
            status: 'active',
            timezone: 'UTC',
            next_run: null,
            last_run: null,
            created_at: '2026-01-01T00:00:00.000Z',
            updated_at: '2026-01-01T00:00:00.000Z',
            WEBHOOKS: [{ URL: 'https://example.test/hook' }],
            STEPS: [{
                ORDER: 1,
                ID: 'only',
                NAME: 'Only',
                TYPE: 'SCRIPT',
                STEP_PARAMS: { CODE: '() => null' },
                WHEN: { PATH: 'input.enabled' }
            }]
        } satisfies Job;
        const rebuilt = buildJobDefinition(createJobForm(job));
        expect(rebuilt.WEBHOOKS).toEqual([{ URL: 'https://example.test/hook' }]);
        expect(rebuilt.STEPS[0]?.WHEN).toEqual({ PATH: 'input.enabled' });
        expect(stripJobReadOnly(job)).not.toHaveProperty('next_run');
        expect(stripJobReadOnly(job)).not.toHaveProperty('created_at');
    });

    it('rejects malformed JSON before making an API request', () => {
        const form = createJobForm();
        form.advanced = '{broken';
        expect(() => buildJobDefinition(form)).toThrow(JobFormError);
    });
});
