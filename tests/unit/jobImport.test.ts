import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { prepareJobImport } from '../../src/jobs/jobImport.js';

describe('legacy job import preparation', () => {
    it('normalizes legacy fields and always prepares inactive jobs', () => {
        const result = prepareJobImport([{
            id: ' legacy-job ',
            name: 'Legacy job',
            status: 'active',
            schedule: '*/5 * * * *',
            maxRetries: 3,
            last_run: '2026-01-01T00:00:00.000Z',
            next_run: '2026-01-01T00:05:00.000Z',
            STEPS: [{
                ORDER: 1,
                ID: 'only',
                NAME: 'Only',
                TYPE: 'SCRIPT',
                STEP_PARAMS: { CODE: '() => null' }
            }]
        }]);

        expect(result.valid).toBe(true);
        if (!result.valid) return;
        expect(result.jobs[0]).toMatchObject({
            id: 'legacy-job',
            status: 'inactive',
            schedule: '0 */5 * * * *',
            timezone: 'UTC',
            DEFAULT_STEP_RETRY: { MAX_ATTEMPTS: 4 }
        });
        expect(Object.hasOwn(result.jobs[0]!, 'last_run')).toBe(false);
        expect(Object.hasOwn(result.jobs[0]!, 'next_run')).toBe(false);
        expect(Object.hasOwn(result.jobs[0]!, 'maxRetries')).toBe(false);
        expect(result.stats).toMatchObject({
            totalJobs: 1,
            schedulesConverted: 1,
            timezonesDefaulted: 1,
            statusesSetInactive: 1,
            readOnlyFieldsRemoved: 2,
            legacyRetriesConverted: 1
        });
    });

    it('rejects duplicate IDs and conflicting retry settings', () => {
        const definition = {
            id: 'duplicate',
            name: 'Duplicate',
            status: 'active',
            timezone: 'UTC',
            maxRetries: 2,
            DEFAULT_STEP_RETRY: { MAX_ATTEMPTS: 3 },
            STEPS: [{
                ORDER: 1,
                ID: 'only',
                NAME: 'Only',
                TYPE: 'SCRIPT',
                STEP_PARAMS: { CODE: '() => null' }
            }]
        };
        const result = prepareJobImport([definition, { ...definition, maxRetries: undefined }]);
        expect(result.valid).toBe(false);
        if (result.valid) return;
        expect(result.errors.map(error => error.code)).toEqual(expect.arrayContaining([
            'CONFLICTING_RETRY_SETTINGS',
            'DUPLICATE_IMPORT_JOB_ID'
        ]));
    });

    it('prepares every bundled reference job successfully', () => {
        const source = JSON.parse(readFileSync(
            path.resolve(process.cwd(), 'examples/jobs.json'),
            'utf8'
        )) as unknown;
        const result = prepareJobImport(source);
        expect(result.valid).toBe(true);
        if (!result.valid) return;
        expect(result.jobs).toHaveLength(24);
        expect(result.jobs.every(job => job.status === 'inactive')).toBe(true);
        expect(result.stats.schedulesConverted).toBe(21);
    });
});
