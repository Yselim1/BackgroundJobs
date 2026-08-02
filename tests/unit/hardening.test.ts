import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { JobRunner } from '../../src/core/JobRunner.js';
import { CommandExecutor } from '../../src/executors/CommandExecutor.js';
import { resolveWorkerCwd } from '../../src/executors/executorSafety.js';
import { RestApiExecutor } from '../../src/executors/RestApiExecutor.js';
import type { Job, Step } from '../../src/types/index.js';
import { fetchSameOrigin, readResponsePrefix, readResponseText } from '../../src/utils/outboundHttp.js';
import { validateJobDefinition } from '../../src/utils/jobValidator.js';

describe('safe command execution', () => {
    it('keeps runtime input in one process argument', async () => {
        const value = `hello; ${process.execPath} -e "process.exit(99)"`;
        const result = await new CommandExecutor().execute(commandStep({
            EXECUTABLE: process.execPath,
            ARGS: ['-e', 'console.log(JSON.stringify(process.argv.slice(1)))', '{{input.value}}']
        }), { input: { value }, secrets: {} }, { signal: new AbortController().signal });
        expect(JSON.parse((result as { stdout: string }).stdout)).toEqual([value]);
    });

    it('does not inherit server secrets but permits an explicit managed-secret environment value', async () => {
        const previousDatabase = process.env.DATABASE_URL;
        const previousMasterKey = process.env.SECRETS_MASTER_KEY;
        process.env.DATABASE_URL = 'should-not-leak';
        process.env.SECRETS_MASTER_KEY = 'should-not-leak-either';
        try {
            const executor = new CommandExecutor();
            const base = {
                EXECUTABLE: process.execPath,
                ARGS: ['-e', 'console.log(JSON.stringify({ database: process.env.DATABASE_URL ?? null, master: process.env.SECRETS_MASTER_KEY ?? null, token: process.env.JOB_TOKEN ?? null }))']
            };
            const withoutExplicit = await executor.execute(commandStep(base), { input: {}, secrets: {} }, { signal: new AbortController().signal });
            expect(JSON.parse((withoutExplicit as { stdout: string }).stdout)).toEqual({ database: null, master: null, token: null });

            const withExplicit = await executor.execute(commandStep({
                ...base,
                ENV: { JOB_TOKEN: '{{secrets.API_TOKEN}}' }
            }), { input: {}, secrets: { API_TOKEN: 'job-secret' } }, { signal: new AbortController().signal });
            expect(JSON.parse((withExplicit as { stdout: string }).stdout)).toEqual({ database: null, master: null, token: 'job-secret' });
        } finally {
            restoreEnvironment('DATABASE_URL', previousDatabase);
            restoreEnvironment('SECRETS_MASTER_KEY', previousMasterKey);
        }
    });

    it('accepts static legacy commands and rejects unsafe templates', () => {
        expect(validateJobDefinition(job('COMMAND', { COMMAND: 'echo hello' })).valid).toBe(true);
        const invalid = validateJobDefinition({
            ...job('COMMAND', { COMMAND: 'echo hello' }),
            STEPS: [
                commandStep({ COMMAND: 'echo {{input.value}}' }, 'shell'),
                commandStep({ EXECUTABLE: '{{input.binary}}', ARGS: [] }, 'executable'),
                commandStep({ EXECUTABLE: 'node', ARGS: [], CWD: '{{input.cwd}}' }, 'cwd'),
                commandStep({ EXECUTABLE: 'node', ARGS: [], ENV: { VALUE: '{{input.value}}' } }, 'env')
            ]
        });
        expect(invalid.valid).toBe(false);
        if (!invalid.valid) expect(invalid.errors.map(issue => issue.code)).toEqual(expect.arrayContaining([
            'DYNAMIC_SHELL_COMMAND', 'DYNAMIC_EXECUTABLE', 'DYNAMIC_WORKING_DIRECTORY', 'UNSAFE_ENV_TEMPLATE'
        ]));
    });

    it('keeps command working directories inside the configured worker directory', () => {
        const previous = process.env.WORKER_WORK_DIRECTORY;
        const root = path.resolve('worker-test-root');
        process.env.WORKER_WORK_DIRECTORY = root;
        try {
            expect(resolveWorkerCwd(undefined)).toBe(root);
            expect(resolveWorkerCwd('nested')).toBe(path.join(root, 'nested'));
            expect(() => resolveWorkerCwd('..')).toThrow(/must stay within WORKER_WORK_DIRECTORY/u);
            expect(() => resolveWorkerCwd(path.join(root, '..', 'outside'))).toThrow(/must stay within WORKER_WORK_DIRECTORY/u);
        } finally {
            restoreEnvironment('WORKER_WORK_DIRECTORY', previous);
        }
    });
});

describe('bounded same-origin HTTP', () => {
    it('follows same-origin redirects and rejects cross-origin redirects', async () => {
        const calls: string[] = [];
        const sameOriginFetch = (async (input: URL | RequestInfo) => {
            calls.push(String(input));
            return calls.length === 1
                ? new Response(null, { status: 302, headers: { Location: '/next' } })
                : new Response('ok', { status: 200 });
        }) as typeof fetch;
        const response = await fetchSameOrigin('https://example.test/start', { method: 'GET' }, sameOriginFetch);
        expect(await response.text()).toBe('ok');
        expect(calls).toEqual(['https://example.test/start', 'https://example.test/next']);

        const crossOriginFetch = (async () => new Response(null, {
            status: 302,
            headers: { Location: 'https://other.test/next' }
        })) as typeof fetch;
        await expect(fetchSameOrigin('https://example.test/start', {}, crossOriginFetch)).rejects.toThrow(/changed origin/u);
    });

    it('bounds complete bodies and truncates diagnostics', async () => {
        await expect(readResponseText(new Response('x'.repeat(2048)), 1024)).rejects.toThrow(/exceeded/u);
        const prefix = await readResponsePrefix(new Response('y'.repeat(5000)), 4096);
        expect(prefix.text).toHaveLength(4096);
        expect(prefix.truncated).toBe(true);
    });

    it('allows path templates but rejects dynamic origins and invalid response limits', () => {
        expect(validateJobDefinition(job('RESTAPI', {
            URL: 'https://example.test/users/{{input.userId}}',
            MAX_RESPONSE_BYTES: 1024
        })).valid).toBe(true);
        const invalid = validateJobDefinition(job('RESTAPI', {
            URL: 'https://{{input.host}}/users',
            MAX_RESPONSE_BYTES: 100
        }));
        expect(invalid.valid).toBe(false);
        if (!invalid.valid) expect(invalid.errors.map(issue => issue.code)).toEqual(expect.arrayContaining([
            'DYNAMIC_REST_ORIGIN', 'INVALID_RESPONSE_LIMIT'
        ]));
    });

    it('executes templated paths on the authored origin and enforces the response limit', async () => {
        const calls: string[] = [];
        vi.stubGlobal('fetch', (async (input: URL | RequestInfo) => {
            calls.push(String(input));
            return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
        }) as typeof fetch);
        try {
            const result = await new RestApiExecutor().execute(restStep({
                URL: 'https://example.test/users/{{input.userId}}',
                QUERY: { active: '{{input.active}}' },
                MAX_RESPONSE_BYTES: 1024
            }), { input: { userId: 7, active: true }, secrets: {} }, { signal: new AbortController().signal });
            expect(calls).toEqual(['https://example.test/users/7?active=true']);
            expect(result.data).toEqual({ ok: true });
        } finally {
            vi.unstubAllGlobals();
        }

        vi.stubGlobal('fetch', (async () => new Response('x'.repeat(2048))) as typeof fetch);
        try {
            await expect(new RestApiExecutor().execute(restStep({
                URL: 'https://example.test/large',
                MAX_RESPONSE_BYTES: 1024
            }), { input: {}, secrets: {} }, { signal: new AbortController().signal })).rejects.toThrow(/exceeded/u);
        } finally {
            vi.unstubAllGlobals();
        }
    });
});

describe('synchronous scripts', () => {
    it('fails Promise-returning SCRIPT functions explicitly', async () => {
        const result = await new JobRunner().run(job('SCRIPT', { CODE: 'async () => 42' }));
        expect(result.status).toBe('failed');
        expect(result.stepResults.only?.error).toMatch(/Asynchronous SCRIPT functions are unsupported/u);
    });
});

function commandStep(params: Record<string, unknown>, id = 'only'): Step {
    return { ORDER: 1, ID: id, NAME: id, TYPE: 'COMMAND', STEP_PARAMS: params };
}

function restStep(params: Record<string, unknown>): Step {
    return { ORDER: 1, ID: 'only', NAME: 'Only', TYPE: 'RESTAPI', STEP_PARAMS: params };
}

function job(type: string, params: Record<string, unknown>): Job {
    return {
        id: 'hardening-job',
        name: 'Hardening job',
        status: 'inactive',
        timezone: 'UTC',
        STEPS: [{ ORDER: 1, ID: 'only', NAME: 'Only', TYPE: type, STEP_PARAMS: params }]
    };
}

function restoreEnvironment(name: string, value: string | undefined): void {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
}
