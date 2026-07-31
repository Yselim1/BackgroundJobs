import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { getSchemaVersions, migrate } from '../../src/db/migrations.js';
import { createPool, type DatabasePool } from '../../src/db/pool.js';
import { ExecutionRepository } from '../../src/repositories/ExecutionRepository.js';
import { JobRepository } from '../../src/repositories/JobRepository.js';
import { JobExecutionManager } from '../../src/services/JobExecutionManager.js';
import { JobService } from '../../src/services/JobService.js';
import type { Job } from '../../src/types/index.js';

let container: StartedPostgreSqlContainer | undefined;
let pool: DatabasePool;
let jobs: JobRepository;
let executions: ExecutionRepository;

beforeAll(async () => {
    const configuredUrl = process.env.TEST_DATABASE_URL;
    if (configuredUrl === undefined) {
        container = await new PostgreSqlContainer('postgres:18.4-alpine').start();
    }
    pool = createPool(configuredUrl ?? container!.getConnectionUri(), 10);
    await migrate(pool);
    jobs = new JobRepository(pool);
    executions = new ExecutionRepository(pool);
});

beforeEach(async () => {
    await pool.query('TRUNCATE execution_attempts, execution_steps, executions, jobs CASCADE');
});

afterAll(async () => {
    await pool?.end();
    await container?.stop();
});

describe('PostgreSQL repositories and lifecycle', () => {
    it('applies numbered migrations and reports a current schema', async () => {
        const versions = await getSchemaVersions(pool);
        expect(versions.current).toBe(versions.latest);
        expect(versions.latest).toBeGreaterThan(0);
    });

    it('persists jobs transactionally and retains execution history after deletion', async () => {
        await jobs.create(job('history-job', 'inactive'));
        const queued = await executions.enqueueManual('history-job');
        await executions.requestCancellation(queued.executionId);
        await jobs.delete('history-job');
        expect(await jobs.getById('history-job')).toBeUndefined();
        const history = await executions.getDetail(queued.executionId);
        expect(history?.jobId).toBe('history-job');
        expect(history?.jobDefinition.name).toBe('Job history-job');
    });

    it('claims oldest work, protects active jobs, and reconciles interrupted executions', async () => {
        await jobs.create(job('first', 'inactive'));
        await jobs.create(job('second', 'inactive'));
        const first = await executions.enqueueManual('first');
        await new Promise(resolve => setTimeout(resolve, 5));
        await executions.enqueueManual('second');
        await expect(executions.enqueueManual('first')).rejects.toMatchObject({ code: 'JOB_ALREADY_ACTIVE' });
        const claimed = await executions.claimOldestQueued();
        expect(claimed?.executionId).toBe(first.executionId);
        expect(await executions.reconcileInterrupted()).toBe(1);
        expect((await executions.getSummary(first.executionId))?.error?.code).toBe('SERVER_INTERRUPTED');
        expect((await executions.claimOldestQueued())?.jobId).toBe('second');
    });

    it('coalesces missed schedules and records overlaps as skipped', async () => {
        const start = new Date('2026-07-31T12:00:00.000Z');
        await jobs.create({ ...job('scheduled'), schedule: '0 * * * * *' }, start);
        await executions.enqueueManual('scheduled');
        await executions.processDueJobs(new Date('2026-07-31T12:05:45.000Z'));
        const page = await executions.list({ jobId: 'scheduled', limit: 20 });
        const scheduled = page.items.find(item => item.trigger === 'scheduled');
        expect(scheduled?.status).toBe('skipped');
        expect(scheduled?.scheduledFor).toBe('2026-07-31T12:05:00.000Z');
        expect(scheduled?.skipReason).toBe('overlap');
        expect((await jobs.getById('scheduled'))?.next_run).toBe('2026-07-31T12:06:00.000Z');
        await executions.processDueJobs(new Date('2026-07-31T12:05:45.000Z'));
        expect((await executions.list({ jobId: 'scheduled', limit: 20 })).items).toHaveLength(2);
    });

    it('persists normalized step and attempt transitions', async () => {
        await jobs.create(job('observed', 'inactive'));
        const queued = await executions.enqueueManual('observed');
        const claimed = await executions.claimOldestQueued();
        const started = new Date();
        await executions.stepStarted(claimed!.executionId, 'only', started);
        await executions.attemptStarted(claimed!.executionId, 'only', 1, started);
        await executions.attemptFinished(claimed!.executionId, 'only', {
            attempt: 1, status: 'success', startedAt: started.toISOString(), finishedAt: new Date().toISOString(), durationMs: 1
        });
        await executions.stepFinished(claimed!.executionId, {
            stepId: 'only', stepName: 'Only', stepType: 'SCRIPT', status: 'success', attempts: [],
            startedAt: started.toISOString(), finishedAt: new Date().toISOString(), durationMs: 1, output: { ok: true }
        });
        await executions.finishExecution(claimed!.executionId, 'success', null, null);
        const detail = await executions.getDetail(queued.executionId);
        expect(detail?.stepResults.only?.attempts).toHaveLength(1);
        expect(detail?.stepResults.only?.output).toEqual({ ok: true });
    });
});

describe('HTTP execution API', () => {
    it('cancels a running REST request and reaches a durable cancelled state', async () => {
        const server = createServer((_req, res) => {
            setTimeout(() => { if (!res.destroyed) res.end('done'); }, 5000);
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const port = (server.address() as AddressInfo).port;
        const definition = job('running-cancel', 'inactive');
        definition.STEPS[0] = {
            ORDER: 1, ID: 'only', NAME: 'Only', TYPE: 'RESTAPI',
            STEP_PARAMS: { URL: `http://127.0.0.1:${port}/slow`, TIMEOUT_MS: 10000 }
        };
        await jobs.create(definition);
        const queued = await executions.enqueueManual(definition.id);
        const manager = new JobExecutionManager(executions, undefined, 1, 50);
        const service = new JobService(jobs, executions);
        const app = createApp({ pool, jobs: service, executions, manager });
        await manager.start();
        await waitFor(async () => (await executions.getSummary(queued.executionId))?.status === 'running');
        await request(app).post(`/api/executions/${queued.executionId}/cancel`).expect(200);
        await waitFor(async () => (await executions.getSummary(queued.executionId))?.status === 'cancelled');
        expect((await executions.getDetail(queued.executionId))?.stepResults.only?.status).toBe('cancelled');
        await manager.shutdown(1000);
        await new Promise<void>(resolve => server.close(() => resolve()));
    });

    it('never dispatches more than WORKER_CONCURRENCY executions', async () => {
        let activeRequests = 0;
        let maximumActive = 0;
        const server = createServer((_req, res) => {
            activeRequests++;
            maximumActive = Math.max(maximumActive, activeRequests);
            setTimeout(() => { activeRequests--; res.end('ok'); }, 150);
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const port = (server.address() as AddressInfo).port;
        const ids: string[] = [];
        for (let index = 0; index < 3; index++) {
            const definition = job(`capacity-${index}`, 'inactive');
            definition.STEPS[0] = {
                ORDER: 1, ID: 'only', NAME: 'Only', TYPE: 'RESTAPI',
                STEP_PARAMS: { URL: `http://127.0.0.1:${port}/work`, TIMEOUT_MS: 5000 }
            };
            await jobs.create(definition);
            ids.push((await executions.enqueueManual(definition.id)).executionId);
        }
        const manager = new JobExecutionManager(executions, undefined, 2, 25);
        await manager.start();
        await waitFor(async () => {
            const statuses = await Promise.all(ids.map(id => executions.getSummary(id)));
            return statuses.every(item => item?.status === 'success');
        });
        expect(maximumActive).toBe(2);
        await manager.shutdown(1000);
        await new Promise<void>(resolve => server.close(() => resolve()));
    });

    it('queues inactive jobs, supports cancellation, pagination, and legacy aliases', async () => {
        const manager = new JobExecutionManager(executions, undefined, 1, 1000);
        const service = new JobService(jobs, executions);
        const app = createApp({ pool, jobs: service, executions, manager });
        await request(app).post('/api/jobs').send(job('api-job', 'inactive')).expect(201)
            .expect(response => expect(response.body.next_run).toBeNull());
        const run = await request(app).post('/api/jobs/api-job/run').expect(202)
            .expect('Location', /\/api\/executions\//);
        expect(run.body.executionId).toBe(run.body.logId);
        expect(run.body.status).toBe('queued');
        await request(app).get(`/api/executions/${run.body.executionId}`).expect(200)
            .expect(response => expect(response.body.stepResults.only.status).toBe('pending'));
        await request(app).post(`/api/executions/${run.body.executionId}/cancel`).expect(200)
            .expect(response => expect(response.body.status).toBe('cancelled'));
        await request(app).post(`/api/executions/${run.body.executionId}/cancel`).expect(200);
        await request(app).get(`/api/logs/${run.body.executionId}`).expect(200)
            .expect(response => {
                expect(response.body.logId).toBe(run.body.executionId);
                expect(response.body).toHaveProperty('startTime');
                expect(response.body).toHaveProperty('stepResults');
            });
        const list = await request(app).get('/api/executions?status=cancelled&limit=1').expect(200);
        expect(list.body.items).toHaveLength(1);
        await request(app).get('/api/logs').expect(200).expect(response => expect(Array.isArray(response.body)).toBe(true));
        await request(app).get('/health/ready').expect(503);
    });

    it('rejects read-only schedule fields and terminal-state cancellation', async () => {
        const manager = new JobExecutionManager(executions, undefined, 1, 1000);
        const service = new JobService(jobs, executions);
        const app = createApp({ pool, jobs: service, executions, manager });
        await request(app).post('/api/jobs').send({ ...job('invalid'), last_run: 'client-value' }).expect(422);
        await jobs.create(job('terminal', 'inactive'));
        const queued = await executions.enqueueManual('terminal');
        await pool.query(`UPDATE executions SET status = 'success', finished_at = clock_timestamp() WHERE id = $1`, [queued.executionId]);
        await request(app).post(`/api/executions/${queued.executionId}/cancel`).expect(409)
            .expect(response => expect(response.body.code).toBe('EXECUTION_NOT_CANCELLABLE'));
    });
});

function job(id: string, status: Job['status'] = 'active'): Job {
    return {
        id,
        name: `Job ${id}`,
        status,
        timezone: 'UTC',
        STEPS: [{ ORDER: 1, ID: 'only', NAME: 'Only', TYPE: 'SCRIPT', STEP_PARAMS: { CODE: '() => ({ ok: true })' } }]
    };
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('Timed out waiting for execution state.');
}
