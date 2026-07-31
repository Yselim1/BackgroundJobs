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
import { WebhookRepository } from '../../src/repositories/WebhookRepository.js';
import { JobExecutionManager } from '../../src/services/JobExecutionManager.js';
import { JobService } from '../../src/services/JobService.js';
import { WebhookDispatcher, createWebhookSignature } from '../../src/services/WebhookDispatcher.js';
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

    it('retains active work while dry-running and deleting old terminal history', async () => {
        await jobs.create(job('retention-terminal', 'inactive'));
        const terminal = await executions.enqueueManual('retention-terminal');
        await executions.requestCancellation(terminal.executionId);
        await jobs.create(job('retention-active', 'inactive'));
        const active = await executions.enqueueManual('retention-active');
        const cutoff = new Date(Date.now() + 60_000);
        expect(await executions.countTerminalBefore(cutoff)).toBe(1);
        expect(await executions.deleteTerminalBefore(cutoff, 100, true)).toEqual([terminal.executionId]);
        expect(await executions.getSummary(terminal.executionId)).toBeDefined();
        expect(await executions.deleteTerminalBefore(cutoff, 100, false)).toEqual([terminal.executionId]);
        expect(await executions.getSummary(terminal.executionId)).toBeUndefined();
        expect((await executions.getSummary(active.executionId))?.status).toBe('queued');
    });

    it('reconciles webhook deliveries that were interrupted mid-request', async () => {
        const definition = {
            ...job('webhook-restart', 'inactive'),
            WEBHOOKS: [{ URL: 'https://example.test/events', EVENTS: ['success' as const] }]
        };
        await jobs.create(definition);
        const queued = await executions.enqueueManual(definition.id);
        await executions.claimOldestQueued();
        await executions.finishExecution(queued.executionId, 'success', null, null);
        const webhooks = new WebhookRepository(pool);
        const firstClaim = await webhooks.claimDue();
        expect(firstClaim?.attemptCount).toBe(1);
        expect(await webhooks.reconcileDelivering(3)).toBe(1);
        const resumedClaim = await webhooks.claimDue();
        expect(resumedClaim?.deliveryId).toBe(firstClaim?.deliveryId);
        expect(resumedClaim?.attemptCount).toBe(2);
        await webhooks.fail(resumedClaim!.deliveryId, 2, 'still unavailable', null);
        expect((await executions.listWebhookDeliveries(queued.executionId))[0]?.status).toBe('failed');
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

    it('persists runtime input, exposes filtered history, and replays durable SSE events', async () => {
        const manager = new JobExecutionManager(executions, undefined, 1, 25);
        const service = new JobService(jobs, executions);
        const app = createApp({ pool, jobs: service, executions, manager });
        const definition = job('input-events', 'inactive');
        definition.STEPS[0] = {
            ORDER: 1,
            ID: 'only',
            NAME: 'Only',
            TYPE: 'SCRIPT',
            STEP_PARAMS: { CODE: 'context => ({ greeting: context.input.greeting })' }
        };
        await request(app).post('/api/jobs').send(definition).expect(201);
        await request(app).post('/api/jobs/input-events/run').send({ input: [] }).expect(422)
            .expect(response => expect(response.body.code).toBe('INVALID_EXECUTION_INPUT'));
        await request(app).post('/api/jobs/input-events/run').send({ unexpected: true }).expect(422)
            .expect(response => expect(response.body.code).toBe('INVALID_RUN_REQUEST'));
        await manager.start();
        try {
            const run = await request(app).post('/api/jobs/input-events/run')
                .send({ input: { greeting: 'hello' } })
                .expect(202);
            await waitFor(async () => (await executions.getSummary(run.body.executionId as string))?.status === 'success');
            await request(app).get(`/api/executions/${run.body.executionId}`).expect(200)
                .expect(response => {
                    expect(response.body.input).toEqual({ greeting: 'hello' });
                    expect(response.body.stepResults.only.output).toEqual({ greeting: 'hello' });
                });
            const requestedAt = Date.parse(run.body.requestedAt as string);
            const before = new Date(requestedAt - 1_000).toISOString();
            const after = new Date(requestedAt + 1_000).toISOString();
            await request(app)
                .get(`/api/executions?jobId=input-events&trigger=manual&status=success&from=${encodeURIComponent(before)}&to=${encodeURIComponent(after)}`)
                .expect(200)
                .expect(response => expect(response.body.items).toHaveLength(1));
            await request(app).get('/api/executions?trigger=other').expect(400)
                .expect(response => expect(response.body.code).toBe('INVALID_TRIGGER'));
            const stream = await request(app)
                .get(`/api/executions/${run.body.executionId}/events`)
                .set('Last-Event-ID', '0')
                .expect(200)
                .expect('Content-Type', /text\/event-stream/u);
            expect(stream.text).toContain('event: execution.queued');
            expect(stream.text).toContain('event: step.success');
            expect(stream.text).toContain('event: execution.success');
            const firstEvent = (await executions.listEvents(run.body.executionId as string, 0n, 1))[0]!;
            const resumed = await request(app)
                .get(`/api/executions/${run.body.executionId}/events`)
                .set('Last-Event-ID', firstEvent.eventId)
                .expect(200);
            expect(resumed.text).not.toContain('event: execution.queued');
            expect(resumed.text).toContain('event: execution.success');
        } finally {
            await manager.shutdown(1_000);
        }
    });

    it('delivers terminal webhooks from the durable outbox and retries failures', async () => {
        const received: Array<{ body: string; headers: Record<string, string | string[] | undefined> }> = [];
        const webhookServer = createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on('data', chunk => chunks.push(Buffer.from(chunk)));
            req.on('end', () => {
                received.push({ body: Buffer.concat(chunks).toString('utf8'), headers: req.headers });
                if (received.length === 1) {
                    res.statusCode = 500;
                    res.end('retry me');
                } else {
                    res.statusCode = 204;
                    res.end();
                }
            });
        });
        await new Promise<void>(resolve => webhookServer.listen(0, '127.0.0.1', resolve));
        const port = (webhookServer.address() as AddressInfo).port;
        const definition = {
            ...job('webhook-job', 'inactive'),
            WEBHOOKS: [{ URL: `http://127.0.0.1:${port}/events`, EVENTS: ['success' as const] }]
        };
        await jobs.create(definition);
        const queued = await executions.enqueueManual(definition.id, { trace: 'abc' });
        const manager = new JobExecutionManager(executions, undefined, 1, 25);
        const webhookRepository = new WebhookRepository(pool);
        const dispatcher = new WebhookDispatcher(webhookRepository, {
            concurrency: 1,
            pollMs: 20,
            maxAttempts: 3,
            requestTimeoutMs: 1_000,
            signingKey: 'test-signing-key'
        });
        try {
            await manager.start();
            await dispatcher.start();
            await waitFor(async () => (await executions.getSummary(queued.executionId))?.status === 'success');
            await waitFor(async () => (await executions.listWebhookDeliveries(queued.executionId))[0]?.status === 'success');
            const delivery = (await executions.listWebhookDeliveries(queued.executionId))[0]!;
            expect(delivery.attemptCount).toBe(2);
            expect(delivery.responseStatus).toBe(204);
            expect(received).toHaveLength(2);
            const last = received[1]!;
            const payload = JSON.parse(last.body) as { event: string; deliveryId: string; execution: { executionId: string } };
            expect(payload.event).toBe('execution.success');
            expect(payload.execution.executionId).toBe(queued.executionId);
            expect(last.headers['x-backgroundjobs-delivery']).toBe(delivery.deliveryId);
            const timestamp = last.headers['x-backgroundjobs-timestamp'] as string;
            expect(last.headers['x-backgroundjobs-signature']).toBe(
                createWebhookSignature('test-signing-key', timestamp, last.body)
            );
            await request(createApp({ pool, jobs: new JobService(jobs, executions), executions, manager, webhookDispatcher: dispatcher }))
                .get(`/api/executions/${queued.executionId}/webhooks`)
                .expect(200)
                .expect(response => expect(response.body[0].status).toBe('success'));
        } finally {
            await Promise.all([manager.shutdown(1_000), dispatcher.shutdown()]);
            await new Promise<void>(resolve => webhookServer.close(() => resolve()));
        }
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
