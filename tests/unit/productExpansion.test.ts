import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/errors.js';
import type { AuthenticatedActor, Job } from '../../src/types/index.js';
import { canConnectDependency, dependencyClosure, dependentClosure } from '../../src/utils/jobGraph.js';
import { idempotencyHashes, parseIdempotencyKey, stableJson } from '../../src/utils/idempotency.js';
import { defaultInputIssues, resolveJobInput, validateInputSchema } from '../../src/utils/inputSchema.js';

const actor: AuthenticatedActor = {
    userId: '00000000-0000-4000-8000-000000000001',
    email: 'operator@example.test',
    displayName: 'Operator',
    role: 'operator',
    authType: 'session',
    credentialId: '00000000-0000-4000-8000-000000000002',
    passwordChangeRequired: false
};

describe('product expansion primitives', () => {
    it('compiles 2020-12 object schemas and validates complete defaults', () => {
        const job = schemaJob();
        expect(validateInputSchema(job.INPUT_SCHEMA)).toEqual([]);
        expect(defaultInputIssues(job)).toEqual([]);
        expect(resolveJobInput(job, undefined, false)).toEqual({ account: 'default', count: 2 });
        expect(() => resolveJobInput(job, { count: 3 }, true)).toThrowError(AppError);
    });

    it('never merges supplied execution input with DEFAULT_INPUT', () => {
        const job = schemaJob();
        try {
            resolveJobInput(job, { count: 3 }, true);
            throw new Error('Expected validation to fail.');
        } catch (error) {
            expect(error).toBeInstanceOf(AppError);
            expect((error as AppError).code).toBe('EXECUTION_INPUT_SCHEMA_FAILED');
        }
        expect(resolveJobInput(job, { account: 'supplied', count: 3 }, true)).toEqual({ account: 'supplied', count: 3 });
    });

    it('hashes semantically identical requests consistently without storing raw keys', () => {
        expect(stableJson({ b: 2, a: { z: true, y: 1 } })).toBe(stableJson({ a: { y: 1, z: true }, b: 2 }));
        const first = idempotencyHashes(actor, 'run-once', { input: { b: 2, a: 1 } });
        const second = idempotencyHashes(actor, 'run-once', { input: { a: 1, b: 2 } });
        expect(first.requestHash.equals(second.requestHash)).toBe(true);
        expect(first.keyHash.toString('utf8')).not.toContain('run-once');
        expect(() => parseIdempotencyKey(' '.repeat(2))).toThrowError(AppError);
    });

    it('computes replay closures and rejects unsafe DAG connections', () => {
        const nodes = [
            { id: 'fetch', dependsOn: [] },
            { id: 'normalize', dependsOn: ['fetch'] },
            { id: 'publish', dependsOn: ['normalize'] },
            { id: 'audit', dependsOn: ['fetch'] }
        ];
        expect([...dependencyClosure(nodes, 'publish')]).toEqual(['publish', 'normalize', 'fetch']);
        expect([...dependentClosure(nodes, 'normalize')]).toEqual(['normalize', 'publish']);
        expect(canConnectDependency(nodes, 'publish', 'fetch')).toEqual({ valid: false, reason: 'cycle' });
        expect(canConnectDependency(nodes, 'fetch', 'normalize')).toEqual({ valid: false, reason: 'duplicate' });
        expect(canConnectDependency(nodes, 'audit', 'publish').valid).toBe(true);
    });
});

function schemaJob(): Job {
    return {
        id: 'schema-job',
        name: 'Schema job',
        status: 'active',
        timezone: 'UTC',
        INPUT_SCHEMA: {
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            type: 'object',
            additionalProperties: false,
            required: ['account', 'count'],
            properties: {
                account: { type: 'string', minLength: 1 },
                count: { type: 'integer', minimum: 1 }
            }
        },
        DEFAULT_INPUT: { account: 'default', count: 2 },
        STEPS: [{ ORDER: 1, ID: 'only', NAME: 'Only', TYPE: 'SCRIPT', STEP_PARAMS: { CODE: '() => null' } }]
    };
}
