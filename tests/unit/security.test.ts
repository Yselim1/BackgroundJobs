import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { hashPassword, verifyPassword } from '../../src/security/password.js';
import { hasPermission, permissionsForRole } from '../../src/security/permissions.js';
import { extractSecretReferences, normalizeSecretName } from '../../src/services/SecretService.js';
import { JobRunner } from '../../src/core/JobRunner.js';
import type { Job } from '../../src/types/index.js';

describe('security primitives', () => {
    it('hashes passwords with native Argon2id and verifies without storing plaintext', async () => {
        const password = 'correct horse battery staple';
        const encoded = await hashPassword(password);
        expect(encoded).toMatch(/^argon2id\$v=19\$/u);
        expect(encoded).not.toContain(password);
        await expect(verifyPassword(password, encoded)).resolves.toBe(true);
        await expect(verifyPassword('incorrect password', encoded)).resolves.toBe(false);
    });

    it('enforces least-privilege role permissions', () => {
        expect(hasPermission('viewer', 'jobs:read')).toBe(true);
        expect(hasPermission('viewer', 'jobs:run')).toBe(false);
        expect(hasPermission('operator', 'jobs:run')).toBe(true);
        expect(hasPermission('operator', 'jobs:write')).toBe(false);
        expect(hasPermission('admin', 'secrets:manage')).toBe(true);
        expect(hasPermission('admin', 'system:read')).toBe(true);
        expect(hasPermission('operator', 'system:read')).toBe(false);
        expect(permissionsForRole('admin')).toContain('audit:read');
    });

    it('extracts normalized secret references without capturing values', () => {
        const references = extractSecretReferences({
            HEADERS: { Authorization: 'Bearer {{secrets.API_TOKEN}}' },
            ENV: { DATABASE_PASSWORD: '{{ secrets.DB_PASSWORD }}' },
            unrelated: '{{input.value}}'
        });
        expect([...references].sort()).toEqual(['API_TOKEN', 'DB_PASSWORD']);
        expect(normalizeSecretName(' api_token ')).toBe('API_TOKEN');
        expect(() => normalizeSecretName('bad-name')).toThrow(/Secret names/u);
    });

    it('rejects malformed master keys and origins during configuration', () => {
        expect(() => loadConfig({ SECRETS_MASTER_KEY: 'not-a-key' })).toThrow(/32-byte key/u);
        expect(() => loadConfig({ CORS_ALLOWED_ORIGINS: 'https://example.test/path' })).toThrow(/invalid origin/u);
        expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/CORS_ALLOWED_ORIGINS/u);
        expect(() => loadConfig({
            NODE_ENV: 'production',
            AUTH_COOKIE_SECURE: 'false',
            CORS_ALLOWED_ORIGINS: 'https://example.test'
        })).toThrow(/AUTH_COOKIE_SECURE/u);
        expect(loadConfig({
            SECRETS_MASTER_KEY: Buffer.alloc(32, 1).toString('base64'),
            CORS_ALLOWED_ORIGINS: 'https://example.test'
        }).corsAllowedOrigins).toEqual(['https://example.test']);
        expect(loadConfig({}).embeddedWorkerEnabled).toBe(true);
        expect(loadConfig({ EMBEDDED_WORKER_ENABLED: 'false' }).embeddedWorkerEnabled).toBe(false);
        expect(loadConfig({
            NODE_ENV: 'production',
            AUTH_COOKIE_SECURE: 'true',
            CORS_ALLOWED_ORIGINS: 'https://example.test'
        }).embeddedWorkerEnabled).toBe(false);
        expect(loadConfig({ WORKER_REQUIRE_NON_ADMIN: 'true' }).workerRequireNonAdmin).toBe(true);
        expect(loadConfig({ WORKER_WORK_DIRECTORY: path.resolve('worker-data') }).workerWorkDirectory)
            .toBe(path.resolve('worker-data'));
        expect(() => loadConfig({ WORKER_WORK_DIRECTORY: 'relative-worker-data' })).toThrow(/absolute path/u);
    });

    it('redacts managed secret values from persisted step outputs and errors', async () => {
        const definition: Job = {
            id: 'redaction',
            name: 'Redaction',
            status: 'inactive',
            timezone: 'UTC',
            STEPS: [{
                ORDER: 1,
                ID: 'only',
                NAME: 'Only',
                TYPE: 'SCRIPT',
                STEP_PARAMS: { CODE: 'context => ({ copied: context.secrets.API_TOKEN })' }
            }]
        };
        const result = await new JobRunner().run(definition, {
            secrets: { API_TOKEN: 'never-persist-this-value' }
        });
        expect(result.stepResults.only?.output).toEqual({ copied: '[REDACTED]' });
        expect(JSON.stringify(result)).not.toContain('never-persist-this-value');
    });
});
