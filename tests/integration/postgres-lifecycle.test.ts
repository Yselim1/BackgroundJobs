import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import type { Express } from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { getSchemaVersions, migrate, readMigrations } from '../../src/db/migrations.js';
import { createPool, type DatabasePool } from '../../src/db/pool.js';
import { loadConfig } from '../../src/config.js';
import { ExecutionRepository } from '../../src/repositories/ExecutionRepository.js';
import { AutomationRepository } from '../../src/repositories/AutomationRepository.js';
import { JobRepository } from '../../src/repositories/JobRepository.js';
import { WorkerRepository } from '../../src/repositories/WorkerRepository.js';
import { WebhookRepository } from '../../src/repositories/WebhookRepository.js';
import { NotificationRepository } from '../../src/repositories/NotificationRepository.js';
import { JobExecutionManager } from '../../src/services/JobExecutionManager.js';
import { JobService } from '../../src/services/JobService.js';
import { NotificationDispatcher } from '../../src/services/NotificationDispatcher.js';
import { WebhookDispatcher, createWebhookSignature } from '../../src/services/WebhookDispatcher.js';
import type { Job } from '../../src/types/index.js';
import { createSecurityRuntime, type SecurityRuntime } from '../../src/security/runtime.js';

let container: StartedPostgreSqlContainer | undefined;
let pool: DatabasePool;
let jobs: JobRepository;
let executions: ExecutionRepository;
let security: SecurityRuntime;
let adminToken: string;
let adminUserId: string;
const ADMIN_EMAIL = 'admin@integration.test';
const ADMIN_PASSWORD = 'integration-admin-password-123';

beforeAll(async () => {
    const configuredUrl = process.env.TEST_DATABASE_URL;
    if (configuredUrl === undefined) {
        container = await new PostgreSqlContainer('postgres:18.4-alpine').start();
    }
    pool = createPool(configuredUrl ?? container!.getConnectionUri(), 10);
    await migrate(pool);
    jobs = new JobRepository(pool);
    executions = new ExecutionRepository(pool);
    security = createSecurityRuntime(pool, loadConfig({
        NODE_ENV: 'test',
        AUTH_COOKIE_SECURE: 'false',
        SECRETS_MASTER_KEY: Buffer.alloc(32, 7).toString('base64')
    }));
    const admin = await security.auth.bootstrapAdmin(ADMIN_EMAIL, 'Integration Admin', ADMIN_PASSWORD);
    adminUserId = admin.userId;
    adminToken = (await security.auth.createApiToken({
        userId: admin.userId,
        email: admin.email,
        displayName: admin.displayName,
        role: admin.role,
        authType: 'session',
        credentialId: 'integration-bootstrap',
        passwordChangeRequired: false
    }, { name: 'integration-suite' })).token;
});

beforeEach(async () => {
    await pool.query(`TRUNCATE notification_deliveries, notification_policies, notification_channels,
        queue_rate_windows, queue_policies, execution_idempotency,
        execution_attempts, execution_steps, executions, worker_instances, jobs CASCADE`);
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

    it('backfills attention schema with constraints, indexes, and retention cascading', async () => {
        const schema = 'attention_migration_' + randomUUID().replaceAll('-', '');
        const client = await pool.connect();
        try {
            await client.query(`CREATE SCHEMA "${schema}"`);
            await client.query(`SET search_path TO "${schema}"`);
            const migrations = await readMigrations();
            for (const migration of migrations.filter(item => item.version < 5)) {
                await client.query(migration.sql);
            }
            const definition = job('migration-attention', 'inactive');
            await client.query(
                `INSERT INTO jobs(id, definition, status, timezone)
                 VALUES ($1, $2::jsonb, 'inactive', 'UTC')`,
                [definition.id, JSON.stringify(definition)]
            );
            const recentExecution = randomUUID();
            const oldExecution = randomUUID();
            await client.query(
                `INSERT INTO executions(
                    id, job_id, job_definition, input, trigger_type, status,
                    requested_at, finished_at, error_code, error_message
                 ) VALUES
                    ($1, $3, $4::jsonb, '{"source":"recent"}'::jsonb, 'manual', 'failed',
                     clock_timestamp() - interval '2 hours', clock_timestamp() - interval '1 hour', 'RECENT', 'Recent failure'),
                    ($2, $3, $4::jsonb, '{}'::jsonb, 'manual', 'failed',
                     clock_timestamp() - interval '26 hours', clock_timestamp() - interval '25 hours', 'OLD', 'Old failure')`,
                [recentExecution, oldExecution, definition.id, JSON.stringify(definition)]
            );
            const deliveryId = randomUUID();
            await client.query(
                `INSERT INTO webhook_deliveries(
                    id, execution_id, event_type, subscription_index, url, payload,
                    status, attempt_count, last_error
                 ) VALUES ($1, $2, 'execution.failed', 0, 'https://example.test/hook', '{}',
                           'failed', 4, 'Webhook failed')`,
                [deliveryId, recentExecution]
            );
            await client.query(migrations.find(item => item.version === 5)!.sql);

            const items = await client.query<{
                kind: string;
                source_id: string;
                detail_snapshot: Record<string, unknown>;
            }>('SELECT kind, source_id, detail_snapshot FROM operational_attention_items ORDER BY kind');
            expect(items.rows).toHaveLength(2);
            expect(items.rows.some(item => item.source_id === oldExecution)).toBe(false);
            expect(items.rows.find(item => item.kind === 'webhook_failure')?.detail_snapshot).toMatchObject({
                attemptCount: 4,
                lastError: 'Webhook failed'
            });

            const indexes = await client.query<{ indexname: string }>(
                `SELECT indexname FROM pg_indexes
                 WHERE schemaname = $1 AND tablename = 'operational_attention_items'`,
                [schema]
            );
            expect(indexes.rows.map(item => item.indexname)).toEqual(expect.arrayContaining([
                'operational_attention_source_uidx',
                'operational_attention_state_idx',
                'operational_attention_kind_idx',
                'operational_attention_newest_idx',
                'operational_attention_state_newest_idx'
            ]));
            await expect(client.query(
                `INSERT INTO operational_attention_items(
                    id, kind, source_id, execution_id, job_id, reason, detail_snapshot, occurred_at
                 ) SELECT $1, kind, source_id, execution_id, job_id, reason, detail_snapshot, occurred_at
                   FROM operational_attention_items LIMIT 1`,
                [randomUUID()]
            )).rejects.toMatchObject({ code: '23505' });
            await client.query('DELETE FROM executions WHERE id = $1', [recentExecution]);
            expect((await client.query<{ count: string }>(
                'SELECT count(*)::text AS count FROM operational_attention_items'
            )).rows[0]?.count).toBe('0');
        } finally {
            await client.query('SET search_path TO public').catch(() => undefined);
            await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
            client.release();
        }
    });

    it('adds administration lifecycle columns, backfills secret owners, and creates expiry indexes', async () => {
        const schema = 'administration_migration_' + randomUUID().replaceAll('-', '');
        const client = await pool.connect();
        try {
            await client.query(`CREATE SCHEMA "${schema}"`);
            await client.query(`SET search_path TO "${schema}"`);
            const migrations = await readMigrations();
            for (const migration of migrations.filter(item => item.version < 6)) await client.query(migration.sql);
            const userId = randomUUID();
            await client.query(
                `INSERT INTO security_users(id, email, display_name, password_hash, role)
                 VALUES ($1, 'owner@example.test', 'Secret Owner', 'hash', 'admin')`,
                [userId]
            );
            await client.query(
                `INSERT INTO managed_secrets(
                    id, name, encrypted_value, nonce, auth_tag, created_by_user_id
                 ) VALUES ($1, 'MIGRATION_SECRET', decode('aa', 'hex'), decode('bb', 'hex'), decode('cc', 'hex'), $2)`,
                [randomUUID(), userId]
            );
            await client.query(migrations.find(item => item.version === 6)!.sql);
            const user = await client.query<{ password_change_required: boolean }>(
                'SELECT password_change_required FROM security_users WHERE id = $1',
                [userId]
            );
            expect(user.rows[0]?.password_change_required).toBe(false);
            const secret = await client.query<{ owner_user_id: string; expires_on: string | null; last_rotated_by_user_id: string | null }>(
                'SELECT owner_user_id, expires_on, last_rotated_by_user_id FROM managed_secrets WHERE name = $1',
                ['MIGRATION_SECRET']
            );
            expect(secret.rows[0]).toMatchObject({ owner_user_id: userId, expires_on: null, last_rotated_by_user_id: null });
            const indexes = await client.query<{ indexname: string }>(
                `SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = 'managed_secrets'`,
                [schema]
            );
            expect(indexes.rows.map(item => item.indexname)).toEqual(expect.arrayContaining([
                'managed_secrets_owner_idx', 'managed_secrets_expiry_idx'
            ]));
        } finally {
            await client.query('SET search_path TO public').catch(() => undefined);
            await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
            client.release();
        }
    });

    it('migrates a populated version-009 schema without losing job, execution, or Attention history', async () => {
        const schema = 'product_expansion_migration_' + randomUUID().replaceAll('-', '');
        const client = await pool.connect();
        try {
            await client.query(`CREATE SCHEMA "${schema}"`);
            await client.query(`SET search_path TO "${schema}"`);
            const migrations = await readMigrations();
            for (const migration of migrations.filter(item => item.version <= 9)) await client.query(migration.sql);
            const definition = job('migration-009', 'inactive');
            const executionId = randomUUID();
            const attentionId = randomUUID();
            await client.query(
                `INSERT INTO jobs(id, definition, status, timezone)
                 VALUES ($1, $2::jsonb, 'inactive', 'UTC')`,
                [definition.id, JSON.stringify(definition)]
            );
            await client.query(
                `INSERT INTO executions(id, job_id, job_definition, input, trigger_type, status,
                    requested_at, finished_at, error_code, error_message)
                 VALUES ($1, $2, $3::jsonb, '{}'::jsonb, 'manual', 'failed',
                    clock_timestamp() - interval '2 minutes', clock_timestamp() - interval '1 minute',
                    'MIGRATED_FAILURE', 'Preserved failure')`,
                [executionId, definition.id, JSON.stringify(definition)]
            );
            await client.query(
                `INSERT INTO operational_attention_items(
                    id, kind, source_id, execution_id, job_id, reason, detail_snapshot, occurred_at, state
                 ) VALUES ($1, 'execution_failure', $2, $2, $3, 'Preserved failure',
                    '{"errorCode":"MIGRATED_FAILURE"}'::jsonb, clock_timestamp() - interval '1 minute', 'ignored')`,
                [attentionId, executionId, definition.id]
            );
            for (const migration of migrations.filter(item => item.version > 9)) await client.query(migration.sql);

            expect((await client.query<{ count: string }>('SELECT count(*)::text AS count FROM jobs')).rows[0]?.count).toBe('1');
            expect((await client.query<{ count: string }>('SELECT count(*)::text AS count FROM executions')).rows[0]?.count).toBe('1');
            const attention = await client.query<{ state: string; severity: string; fingerprint: string; occurrence_count: number }>(
                'SELECT state, severity, fingerprint, occurrence_count FROM operational_attention_items WHERE id = $1',
                [attentionId]
            );
            expect(attention.rows[0]).toMatchObject({ state: 'ignored', severity: 'high', occurrence_count: 1 });
            expect(attention.rows[0]?.fingerprint).toHaveLength(32);
            const events = await client.query<{ event_type: string }>('SELECT event_type FROM incident_events WHERE attention_id = $1 ORDER BY id', [attentionId]);
            expect(events.rows.map(item => item.event_type)).toEqual(['opened', 'state_changed']);
        } finally {
            await client.query('SET search_path TO public').catch(() => undefined);
            await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
            client.release();
        }
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

    it('bulk imports jobs atomically and refuses existing IDs', async () => {
        await jobs.create(job('existing-import-job', 'inactive'));
        await expect(jobs.createMany([
            job('new-import-job', 'inactive'),
            job('existing-import-job', 'inactive')
        ])).rejects.toMatchObject({ code: 'JOB_ALREADY_EXISTS' });
        expect(await jobs.getById('new-import-job')).toBeUndefined();

        const created = await jobs.createMany([
            job('import-one', 'inactive'),
            job('import-two', 'inactive')
        ]);
        expect(created.map(item => item.id)).toEqual(['import-one', 'import-two']);
        expect(created.every(item => item.next_run === null)).toBe(true);
    });

    it('claims oldest work, backlogs repeated requests, and reconciles interrupted executions', async () => {
        await jobs.create(job('first', 'inactive'));
        await jobs.create(job('second', 'inactive'));
        const first = await executions.enqueueManual('first');
        await new Promise(resolve => setTimeout(resolve, 5));
        await executions.enqueueManual('second');
        const repeated = await executions.enqueueManual('first');
        expect(repeated.status).toBe('queued');
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
        await pool.query(
            `INSERT INTO webhook_deliveries(
                id, execution_id, event_type, subscription_index, url, payload, status
             ) VALUES ($1, $2, 'execution.success', 1, 'https://example.test/interrupted', '{}', 'pending')`,
            [randomUUID(), queued.executionId]
        );
        const finalInterrupted = await webhooks.claimDue();
        expect(finalInterrupted?.attemptCount).toBe(1);
        expect(await webhooks.reconcileDelivering(1)).toBe(1);
        const deliveries = await executions.listWebhookDeliveries(queued.executionId);
        expect(deliveries.every(item => item.status === 'failed')).toBe(true);
        const attention = await pool.query<{ source_id: string; state: string }>(
            `SELECT source_id, state FROM operational_attention_items
             WHERE kind = 'webhook_failure' AND execution_id = $1`,
            [queued.executionId]
        );
        expect(attention.rows).toHaveLength(2);
        expect(attention.rows.every(item => item.state === 'open')).toBe(true);
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
        const app = createApp({ pool, jobs: service, executions, manager, security });
        await manager.start();
        await waitFor(async () => (await executions.getSummary(queued.executionId))?.status === 'running');
        await authenticatedRequest(app).post(`/api/executions/${queued.executionId}/cancel`).expect(200);
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
        const app = createApp({ pool, jobs: service, executions, manager, security });
        await authenticatedRequest(app).post('/api/jobs').send(job('api-job', 'inactive')).expect(201)
            .expect(response => expect(response.body.next_run).toBeNull());
        const run = await authenticatedRequest(app).post('/api/jobs/api-job/run').expect(202)
            .expect('Location', /\/api\/executions\//);
        expect(run.body.executionId).toBe(run.body.logId);
        expect(run.body.status).toBe('queued');
        await authenticatedRequest(app).get(`/api/executions/${run.body.executionId}`).expect(200)
            .expect(response => expect(response.body.stepResults.only.status).toBe('pending'));
        await authenticatedRequest(app).post(`/api/executions/${run.body.executionId}/cancel`).expect(200)
            .expect(response => expect(response.body.status).toBe('cancelled'));
        await authenticatedRequest(app).post(`/api/executions/${run.body.executionId}/cancel`).expect(200);
        await authenticatedRequest(app).get(`/api/logs/${run.body.executionId}`).expect(200)
            .expect(response => {
                expect(response.body.logId).toBe(run.body.executionId);
                expect(response.body).toHaveProperty('startTime');
                expect(response.body).toHaveProperty('stepResults');
            });
        const list = await authenticatedRequest(app).get('/api/executions?status=cancelled&limit=1').expect(200);
        expect(list.body.items).toHaveLength(1);
        await authenticatedRequest(app).get('/api/logs').expect(200).expect(response => expect(Array.isArray(response.body)).toBe(true));
        await authenticatedRequest(app).get('/health/ready').expect(503);
    });

    it('supports exact page-mode execution history without changing cursor clients', async () => {
        const manager = new JobExecutionManager(executions, undefined, 1, 1000);
        const app = createApp({
            pool,
            jobs: new JobService(jobs, executions),
            executions,
            manager,
            security
        });
        const ids: string[] = [];
        for (let index = 0; index < 3; index++) {
            const jobId = 'paged-execution-' + index;
            await jobs.create(job(jobId, 'inactive'));
            ids.push((await executions.enqueueManual(jobId)).executionId);
            await new Promise(resolve => setTimeout(resolve, 5));
        }

        await authenticatedRequest(app).get('/api/executions?page=1&limit=2&order=asc').expect(200)
            .expect(response => {
                expect(response.body.items.map((item: { executionId: string }) => item.executionId)).toEqual(ids.slice(0, 2));
                expect(response.body).toMatchObject({ page: 1, pageSize: 2, total: 3, totalPages: 2 });
                expect(response.body).not.toHaveProperty('nextCursor');
            });
        await authenticatedRequest(app).get('/api/executions?page=2&limit=2&order=asc').expect(200)
            .expect(response => expect(response.body.items[0].executionId).toBe(ids[2]));
        await authenticatedRequest(app).get('/api/executions?page=99&limit=2').expect(200)
            .expect(response => {
                expect(response.body.items).toEqual([]);
                expect(response.body).toMatchObject({ page: 99, total: 3, totalPages: 2 });
            });

        const cursorPage = await authenticatedRequest(app).get('/api/executions?limit=2&order=asc').expect(200);
        expect(cursorPage.body.nextCursor).toBeTypeOf('string');
        await authenticatedRequest(app)
            .get('/api/executions?page=1&cursor=' + encodeURIComponent(cursorPage.body.nextCursor as string))
            .expect(400)
            .expect(response => expect(response.body.code).toBe('CONFLICTING_PAGINATION'));
        await authenticatedRequest(app).get('/api/executions?page=0').expect(400)
            .expect(response => expect(response.body.code).toBe('INVALID_PAGE'));
        await authenticatedRequest(app).get('/api/executions?from=2026-01-01').expect(400)
            .expect(response => expect(response.body.code).toBe('INVALID_FROM'));
        await authenticatedRequest(app).get('/api/executions?from=2026-02-30T00%3A00%3A00Z').expect(400)
            .expect(response => expect(response.body.code).toBe('INVALID_FROM'));
    });

    it('rejects read-only schedule fields and terminal-state cancellation', async () => {
        const manager = new JobExecutionManager(executions, undefined, 1, 1000);
        const service = new JobService(jobs, executions);
        const app = createApp({ pool, jobs: service, executions, manager, security });
        await authenticatedRequest(app).post('/api/jobs').send({ ...job('invalid'), last_run: 'client-value' }).expect(422);
        await jobs.create(job('terminal', 'inactive'));
        const queued = await executions.enqueueManual('terminal');
        await pool.query(`UPDATE executions SET status = 'success', finished_at = clock_timestamp() WHERE id = $1`, [queued.executionId]);
        await authenticatedRequest(app).post(`/api/executions/${queued.executionId}/cancel`).expect(409)
            .expect(response => expect(response.body.code).toBe('EXECUTION_NOT_CANCELLABLE'));
    });

    it('lets administrators activate and deactivate scheduled jobs through replacement', async () => {
        const manager = new JobExecutionManager(executions, undefined, 1, 1000);
        const service = new JobService(jobs, executions);
        const app = createApp({ pool, jobs: service, executions, manager, security });
        const definition = { ...job('managed-status', 'inactive'), schedule: '0 * * * * *' };
        await authenticatedRequest(app).post('/api/jobs').send(definition).expect(201)
            .expect(response => expect(response.body.next_run).toBeNull());
        await authenticatedRequest(app).put('/api/jobs/managed-status')
            .set('If-Match', '"1"')
            .send({ ...definition, status: 'active' })
            .expect(200)
            .expect(response => {
                expect(response.body.status).toBe('active');
                expect(response.body.next_run).toBeTypeOf('string');
            });
        await authenticatedRequest(app).put('/api/jobs/managed-status')
            .set('If-Match', '"2"')
            .send(definition)
            .expect(200)
            .expect(response => {
                expect(response.body.status).toBe('inactive');
                expect(response.body.next_run).toBeNull();
            });
    });

    it('previews schedules and updates multiple job statuses atomically', async () => {
        const manager = new JobExecutionManager(executions, undefined, 3, 1000);
        const app = createApp({
            pool,
            jobs: new JobService(jobs, executions),
            executions,
            manager,
            security
        });
        await Promise.all([
            jobs.create({ ...job('bulk-one', 'inactive'), schedule: '*/10 * * * * *', timezone: 'Europe/Istanbul' }),
            jobs.create({ ...job('bulk-two', 'inactive'), schedule: '0 * * * * *' })
        ]);

        await authenticatedRequest(app).post('/api/jobs/schedule-preview')
            .send({ schedule: '*/10 * * * * *', timezone: 'Europe/Istanbul', count: 3 })
            .expect(200)
            .expect(response => {
                expect(response.body.occurrences).toHaveLength(3);
                expect(Date.parse(response.body.occurrences[1]) - Date.parse(response.body.occurrences[0])).toBe(10_000);
            });
        await authenticatedRequest(app).post('/api/jobs/schedule-preview')
            .send({ schedule: '* * * * *', timezone: 'UTC' })
            .expect(422)
            .expect(response => expect(response.body.code).toBe('INVALID_SCHEDULE_PREVIEW'));

        await authenticatedRequest(app).post('/api/jobs/bulk-status')
            .send({ jobIds: ['bulk-one', 'bulk-two'], status: 'active' })
            .expect(200)
            .expect(response => {
                expect(response.body.items).toHaveLength(2);
                expect(response.body.items.every((item: { status: string }) => item.status === 'active')).toBe(true);
                expect(response.body.items.every((item: { next_run: string | null }) => item.next_run !== null)).toBe(true);
            });

        const cursor = await executions.latestEventId();
        const queued = await executions.enqueueManual('bulk-one');
        await new Promise(resolve => setTimeout(resolve, 5));
        const secondQueued = await executions.enqueueManual('bulk-two');
        const events = await executions.listEventsAfter(cursor);
        expect(events.some(event => event.executionId === queued.executionId && event.type === 'execution.queued')).toBe(true);
        await authenticatedRequest(app).get('/api/executions?order=asc&limit=1').expect(200)
            .expect(response => {
                expect(response.body.items[0].executionId).toBe(queued.executionId);
                expect(response.body.nextCursor).toBeTypeOf('string');
            });
        await authenticatedRequest(app).get('/api/executions?order=sideways').expect(400)
            .expect(response => expect(response.body.code).toBe('INVALID_ORDER'));
        expect(secondQueued.executionId).not.toBe(queued.executionId);
        await authenticatedRequest(app).post('/api/jobs/bulk-status')
            .send({ jobIds: ['bulk-one'], status: 'inactive' })
            .expect(200)
            .expect(response => expect(response.body.items[0].status).toBe('inactive'));
    });

    it('persists runtime input, exposes filtered history, and replays durable SSE events', async () => {
        const manager = new JobExecutionManager(executions, undefined, 1, 25);
        const service = new JobService(jobs, executions);
        const app = createApp({ pool, jobs: service, executions, manager, security });
        const definition = job('input-events', 'inactive');
        definition.STEPS[0] = {
            ORDER: 1,
            ID: 'only',
            NAME: 'Only',
            TYPE: 'SCRIPT',
            STEP_PARAMS: { CODE: 'context => ({ greeting: context.input.greeting })' }
        };
        await authenticatedRequest(app).post('/api/jobs').send(definition).expect(201);
        await authenticatedRequest(app).post('/api/jobs/input-events/run').send({ input: [] }).expect(422)
            .expect(response => expect(response.body.code).toBe('INVALID_EXECUTION_INPUT'));
        await authenticatedRequest(app).post('/api/jobs/input-events/run').send({ unexpected: true }).expect(422)
            .expect(response => expect(response.body.code).toBe('INVALID_RUN_REQUEST'));
        await manager.start();
        try {
            const run = await authenticatedRequest(app).post('/api/jobs/input-events/run')
                .send({ input: { greeting: 'hello' } })
                .expect(202);
            await waitFor(async () => (await executions.getSummary(run.body.executionId as string))?.status === 'success');
            await authenticatedRequest(app).get(`/api/executions/${run.body.executionId}`).expect(200)
                .expect(response => {
                    expect(response.body.input).toEqual({ greeting: 'hello' });
                    expect(response.body.stepResults.only.output).toEqual({ greeting: 'hello' });
                });
            const requestedAt = Date.parse(run.body.requestedAt as string);
            const before = new Date(requestedAt - 1_000).toISOString();
            const after = new Date(requestedAt + 1_000).toISOString();
            await authenticatedRequest(app)
                .get(`/api/executions?jobId=input-events&trigger=manual&status=success&from=${encodeURIComponent(before)}&to=${encodeURIComponent(after)}`)
                .expect(200)
                .expect(response => expect(response.body.items).toHaveLength(1));
            await authenticatedRequest(app).get('/api/executions?trigger=other').expect(400)
                .expect(response => expect(response.body.code).toBe('INVALID_TRIGGER'));
            const stream = await authenticatedRequest(app)
                .get(`/api/executions/${run.body.executionId}/events`)
                .set('Last-Event-ID', '0')
                .expect(200)
                .expect('Content-Type', /text\/event-stream/u);
            expect(stream.text).toContain('event: execution.queued');
            expect(stream.text).toContain('event: step.success');
            expect(stream.text).toContain('event: execution.success');
            const firstEvent = (await executions.listEvents(run.body.executionId as string, 0n, 1))[0]!;
            const resumed = await authenticatedRequest(app)
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
        await security.secrets.put(
            'WEBHOOK_TEST_KEY',
            'test-signing-key',
            'Integration webhook signing key',
            adminUserId
        );
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
            WEBHOOKS: [{
                URL: `http://127.0.0.1:${port}/events`,
                EVENTS: ['success' as const],
                SIGNING_SECRET: 'WEBHOOK_TEST_KEY'
            }]
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
            secrets: security.secrets
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
            await authenticatedRequest(createApp({ pool, jobs: new JobService(jobs, executions), executions, manager, webhookDispatcher: dispatcher, security }))
                .get(`/api/executions/${queued.executionId}/webhooks`)
                .expect(200)
                .expect(response => expect(response.body[0].status).toBe('success'));
        } finally {
            await Promise.all([manager.shutdown(1_000), dispatcher.shutdown()]);
            await new Promise<void>(resolve => webhookServer.close(() => resolve()));
        }
    });

    it('returns ordered attention previews for failed executions and webhook deliveries', async () => {
        const definition = {
            ...job('attention-failure', 'inactive'),
            WEBHOOKS: [{
                URL: 'https://example.test/failure',
                EVENTS: ['failed' as const]
            }]
        };
        await jobs.create(definition);
        const failed = await executions.enqueueManual(definition.id);
        await executions.claimOldestQueued();
        await executions.finishExecution(failed.executionId, 'failed', 'TEST_FAILURE', 'Execution exploded.');
        const webhookRepository = new WebhookRepository(pool);
        const delivery = await webhookRepository.claimDue();
        expect(delivery?.executionId).toBe(failed.executionId);
        await webhookRepository.fail(delivery!.deliveryId, 1, 'Remote endpoint unavailable.', 503);
        const manager = new JobExecutionManager(executions, undefined, 1, 1000);
        const app = createApp({
            pool,
            jobs: new JobService(jobs, executions),
            executions,
            manager,
            security
        });
        await authenticatedRequest(app).get('/api/platform/overview').expect(200)
            .expect(response => {
                expect(response.body.executions.failed24h).toBe(1);
                expect(response.body.webhooks.failed).toBe(1);
                expect(response.body.attention.openExecutionFailures).toBe(1);
                expect(response.body.attention.openWebhookFailures).toBe(1);
                expect(response.body.attention.failedExecutions[0]).toMatchObject({
                    kind: 'execution_failure',
                    sourceId: failed.executionId,
                    executionId: failed.executionId,
                    jobId: definition.id,
                    reason: 'Execution exploded.'
                });
                expect(response.body.attention.failedExecutions[0].detailSnapshot.errorCode).toBe('TEST_FAILURE');
                expect(response.body.attention.failedWebhooks[0]).toMatchObject({
                    kind: 'webhook_failure',
                    sourceId: delivery!.deliveryId,
                    executionId: failed.executionId,
                    jobId: definition.id,
                    reason: 'Remote endpoint unavailable.'
                });
                expect(response.body.attention.failedWebhooks[0].detailSnapshot).toMatchObject({
                    attemptCount: 1,
                    responseStatus: 503
                });
            });
    });

    it('lists, filters, ignores, restores, and reruns durable attention items', async () => {
        const definition = job('attention-api', 'inactive');
        await jobs.create(definition);
        const failed = await executions.enqueueManual(definition.id, { accountId: 42 });
        await executions.claimOldestQueued();
        await executions.finishExecution(failed.executionId, 'failed', 'API_FAILURE', 'Customer sync exploded.');
        const manager = new JobExecutionManager(executions, undefined, 1, 1000);
        const app = createApp({
            pool,
            jobs: new JobService(jobs, executions),
            executions,
            manager,
            security
        });

        const page = await authenticatedRequest(app).get('/api/attention?state=open&page=1&limit=25').expect(200);
        expect(page.body).toMatchObject({ page: 1, pageSize: 25, total: 1, totalPages: 1 });
        const item = page.body.items[0] as {
            attentionId: string;
            occurredAt: string;
            state: string;
            sourceId: string;
        };
        expect(item).toMatchObject({ state: 'open', sourceId: failed.executionId });
        const calendarDay = item.occurredAt.slice(0, 10);
        await authenticatedRequest(app)
            .get('/api/attention?state=open&kind=execution_failure&search=sync&from=' + calendarDay + '&to=' + calendarDay + '&page=1&limit=25')
            .expect(200)
            .expect(response => expect(response.body.total).toBe(1));
        await authenticatedRequest(app).get('/api/attention?state=ignored&page=1&limit=25').expect(200)
            .expect(response => expect(response.body.total).toBe(0));
        await authenticatedRequest(app).get('/api/attention/' + item.attentionId).expect(200)
            .expect(response => expect(response.body.detailSnapshot.input).toEqual({ accountId: 42 }));

        const ignored = await authenticatedRequest(app).post('/api/attention/' + item.attentionId + '/ignore').expect(200);
        expect(ignored.body.state).toBe('ignored');
        const ignoredAgain = await authenticatedRequest(app).post('/api/attention/' + item.attentionId + '/ignore').expect(200);
        expect(ignoredAgain.body.stateChangedAt).toBe(ignored.body.stateChangedAt);
        await authenticatedRequest(app).get('/api/platform/overview').expect(200).expect(response => {
            expect(response.body.attention.openExecutionFailures).toBe(0);
            expect(response.body.attention.failedExecutions).toEqual([]);
            expect(response.body.executions.failed24h).toBe(1);
        });

        const restored = await authenticatedRequest(app).post('/api/attention/' + item.attentionId + '/restore').expect(200);
        expect(restored.body.state).toBe('open');
        const restoredAgain = await authenticatedRequest(app).post('/api/attention/' + item.attentionId + '/restore').expect(200);
        expect(restoredAgain.body.stateChangedAt).toBe(restored.body.stateChangedAt);

        await jobs.replace(definition.id, { ...definition, name: 'Current job definition' });
        const resolved = await authenticatedRequest(app).post('/api/attention/' + item.attentionId + '/rerun').expect(200);
        expect(resolved.body).toMatchObject({ state: 'resolved', resolutionAction: 'rerun' });
        const newExecutionId = resolved.body.resolutionDetails.newExecutionId as string;
        const rerun = await executions.getDetail(newExecutionId);
        expect(rerun?.input).toEqual({ accountId: 42 });
        expect(rerun?.jobDefinition.name).toBe('Current job definition');
        await authenticatedRequest(app).post('/api/attention/' + item.attentionId + '/rerun').expect(409)
            .expect(response => expect(response.body.code).toBe('ATTENTION_STATE_CONFLICT'));
        await authenticatedRequest(app).post('/api/attention/' + item.attentionId + '/ignore').expect(409);

        await waitFor(async () => {
            const audit = await security.audit.list({ limit: 50, action: 'attention.' });
            const actions = new Set(audit.items.map(event => event.action));
            return actions.has('attention.ignore')
                && actions.has('attention.restore')
                && actions.has('attention.rerun');
        });

        const pagedSources = Array.from({ length: 26 }, () => randomUUID());
        const pagedAttentionIds = Array.from({ length: 26 }, () => randomUUID());
        await pool.query(
            `INSERT INTO executions(
                id, job_id, job_definition, input, trigger_type, status,
                requested_at, finished_at, error_message
             )
             SELECT source_id, 'paged-attention-' || (ordinality - 1), $2::jsonb, '{}'::jsonb,
                    'manual', 'failed', clock_timestamp() - (ordinality * interval '1 second'),
                    clock_timestamp() - (ordinality * interval '1 second'), 'Paged attention failure'
             FROM unnest($1::uuid[]) WITH ORDINALITY AS sources(source_id, ordinality)`,
            [pagedSources, JSON.stringify(definition)]
        );
        await pool.query(
            `INSERT INTO operational_attention_items(
                id, kind, source_id, execution_id, job_id, reason, detail_snapshot, occurred_at
             )
             SELECT attention_id, 'execution_failure', source_id, source_id,
                    'paged-attention-' || (sources.ordinality - 1),
                    'Paged attention failure', '{}'::jsonb,
                    clock_timestamp() - (sources.ordinality * interval '1 second')
             FROM unnest($1::uuid[]) WITH ORDINALITY AS sources(source_id, ordinality)
             JOIN unnest($2::uuid[]) WITH ORDINALITY AS items(attention_id, ordinality)
               ON items.ordinality = sources.ordinality`,
            [pagedSources, pagedAttentionIds]
        );
        await authenticatedRequest(app).get('/api/attention?state=open&page=1&limit=25').expect(200)
            .expect(response => expect(response.body).toMatchObject({ total: 26, totalPages: 2, pageSize: 25 }));
        await authenticatedRequest(app).get('/api/attention?state=open&page=2&limit=25').expect(200)
            .expect(response => expect(response.body.items).toHaveLength(1));
        await authenticatedRequest(app).get('/api/attention?state=open&search=paged-attention-25&page=1&limit=50').expect(200)
            .expect(response => expect(response.body.total).toBe(1));

        await authenticatedRequest(app).get('/api/attention?state=invalid').expect(400);
        await authenticatedRequest(app).get('/api/attention?kind=invalid').expect(400);
        await authenticatedRequest(app).get('/api/attention?limit=10').expect(400);
        await authenticatedRequest(app).get('/api/attention?from=2026-02-30').expect(400);
        await authenticatedRequest(app).get('/api/attention?from=2026-08-02&to=2026-08-01').expect(400);
        await authenticatedRequest(app).get('/api/attention/not-a-uuid').expect(400);
        await authenticatedRequest(app).get('/api/attention/00000000-0000-4000-8000-000000000000').expect(404);
    });

    it('keeps rerun attention open when the current job is missing and queues behind active work', async () => {
        const manager = new JobExecutionManager(executions, undefined, 1, 1000);
        const app = createApp({ pool, jobs: new JobService(jobs, executions), executions, manager, security });

        await jobs.create(job('attention-missing-job', 'inactive'));
        const missingFailure = await executions.enqueueManual('attention-missing-job');
        await executions.claimOldestQueued();
        await executions.finishExecution(missingFailure.executionId, 'failed', 'FAILED', 'Missing job failure');
        const missingItem = (await authenticatedRequest(app).get('/api/attention?search=attention-missing-job').expect(200)).body.items[0];
        await jobs.delete('attention-missing-job');
        await authenticatedRequest(app).post('/api/attention/' + missingItem.attentionId + '/rerun').expect(409)
            .expect(response => expect(response.body.code).toBe('ATTENTION_JOB_MISSING'));
        await authenticatedRequest(app).get('/api/attention/' + missingItem.attentionId).expect(200)
            .expect(response => expect(response.body.state).toBe('open'));

        await jobs.create(job('attention-active-job', 'inactive'));
        const activeFailure = await executions.enqueueManual('attention-active-job');
        await executions.claimOldestQueued();
        await executions.finishExecution(activeFailure.executionId, 'failed', 'FAILED', 'Active job failure');
        const activeItem = (await authenticatedRequest(app).get('/api/attention?search=attention-active-job').expect(200)).body.items[0];
        await executions.enqueueManual('attention-active-job');
        await authenticatedRequest(app).post('/api/attention/' + activeItem.attentionId + '/rerun').expect(200)
            .expect(response => expect(response.body.state).toBe('resolved'));
        await authenticatedRequest(app).get('/api/attention/' + activeItem.attentionId).expect(200)
            .expect(response => expect(response.body.state).toBe('resolved'));
    });

    it('retries exact webhook deliveries, preserves attempts, and reopens repeated failures', async () => {
        const createFailedDelivery = async (jobId: string) => {
            const definition = {
                ...job(jobId, 'inactive'),
                WEBHOOKS: [{ URL: 'https://example.test/manual-retry', EVENTS: ['failed' as const] }]
            };
            await jobs.create(definition);
            const execution = await executions.enqueueManual(jobId);
            await executions.claimOldestQueued();
            await executions.finishExecution(execution.executionId, 'failed', 'SOURCE_FAILURE', 'Execution failed.');
            const repository = new WebhookRepository(pool);
            const claimed = await repository.claimDue();
            expect(claimed?.executionId).toBe(execution.executionId);
            await repository.fail(claimed!.deliveryId, 1, 'Initial terminal failure.', 502);
            return { execution, deliveryId: claimed!.deliveryId, repository };
        };

        const successful = await createFailedDelivery('attention-webhook-success');
        const manager = new JobExecutionManager(executions, undefined, 1, 1000);
        const successDispatcher = new WebhookDispatcher(successful.repository, {
            concurrency: 1,
            pollMs: 1000,
            maxAttempts: 1,
            fetchImplementation: async () => new Response(null, { status: 204 })
        });
        await successDispatcher.start();
        try {
            const app = createApp({
                pool,
                jobs: new JobService(jobs, executions),
                executions,
                manager,
                webhookDispatcher: successDispatcher,
                security
            });
            const item = (await authenticatedRequest(app)
                .get('/api/attention?kind=webhook_failure&search=' + successful.deliveryId)
                .expect(200)).body.items[0];
            const resolved = await authenticatedRequest(app)
                .post('/api/attention/' + item.attentionId + '/retry-webhook')
                .expect(200);
            expect(resolved.body).toMatchObject({
                attentionId: item.attentionId,
                state: 'resolved',
                resolutionAction: 'webhook_retry'
            });
            expect(resolved.body.resolutionDetails.attemptCountBeforeRetry).toBe(1);
            await waitFor(async () => (
                await executions.listWebhookDeliveries(successful.execution.executionId)
            )[0]?.status === 'success');
            expect((await executions.listWebhookDeliveries(successful.execution.executionId))[0]?.attemptCount).toBe(2);
            await authenticatedRequest(app).get('/api/attention/' + item.attentionId).expect(200)
                .expect(response => expect(response.body.state).toBe('resolved'));
            await authenticatedRequest(app).post('/api/attention/' + item.attentionId + '/retry-webhook').expect(409);
        } finally {
            await successDispatcher.shutdown();
        }

        const repeated = await createFailedDelivery('attention-webhook-reopen');
        const failureDispatcher = new WebhookDispatcher(repeated.repository, {
            concurrency: 1,
            pollMs: 1000,
            maxAttempts: 1,
            fetchImplementation: async () => new Response('still unavailable', { status: 503 })
        });
        await failureDispatcher.start();
        try {
            const app = createApp({
                pool,
                jobs: new JobService(jobs, executions),
                executions,
                manager,
                webhookDispatcher: failureDispatcher,
                security
            });
            const item = (await authenticatedRequest(app)
                .get('/api/attention?kind=webhook_failure&search=' + repeated.deliveryId)
                .expect(200)).body.items[0];
            await authenticatedRequest(app).post('/api/attention/' + item.attentionId + '/retry-webhook').expect(200);
            await waitFor(async () => {
                const current = await authenticatedRequest(app).get('/api/attention/' + item.attentionId);
                return current.body.state === 'open' && current.body.reason.includes('HTTP 503');
            });
            const delivery = (await executions.listWebhookDeliveries(repeated.execution.executionId))[0]!;
            expect(delivery).toMatchObject({ status: 'failed', attemptCount: 2, responseStatus: 503 });
            const reopened = await authenticatedRequest(app).get('/api/attention/' + item.attentionId).expect(200);
            expect(reopened.body).toMatchObject({
                attentionId: item.attentionId,
                state: 'open',
                resolutionAction: null,
                resolutionDetails: null
            });
        } finally {
            await failureDispatcher.shutdown();
        }

        await waitFor(async () => {
            const audit = await security.audit.list({ limit: 50, action: 'attention.webhook_retry' });
            return audit.items.length >= 2;
        });
    });

    it('persists fan-out item attempts, conditional skips, plans, and platform overview data', async () => {
        const definition = job('platform-workflow', 'inactive');
        definition.MAX_CONCURRENCY = 2;
        definition.STEPS = [
            {
                ORDER: 1,
                ID: 'map',
                NAME: 'Map items',
                TYPE: 'SCRIPT',
                FOREACH: { ITEMS: 'input.items', MAX_CONCURRENCY: 4 },
                STEP_PARAMS: { CODE: 'context => ({ value: context.item, index: context.index })' }
            },
            {
                ORDER: 2,
                ID: 'optional',
                NAME: 'Optional branch',
                TYPE: 'SCRIPT',
                WHEN: { PATH: 'input.runOptional' },
                STEP_PARAMS: { CODE: '() => ({ ran: true })' }
            },
            {
                ORDER: 3,
                ID: 'after',
                NAME: 'After branch',
                TYPE: 'SCRIPT',
                DEPENDS_ON: ['optional'],
                STEP_PARAMS: { CODE: 'context => ({ skippedValue: context.optional })' }
            }
        ];
        await jobs.create(definition);
        const queued = await executions.enqueueManual(definition.id, {
            items: ['alpha', 'beta', 'gamma'],
            runOptional: false
        });
        const manager = new JobExecutionManager(executions, undefined, 1, 25);
        const app = createApp({ pool, jobs: new JobService(jobs, executions), executions, manager, security });
        try {
            await manager.start();
            await waitFor(async () => (await executions.getSummary(queued.executionId))?.status === 'success');
            const detail = await executions.getDetail(queued.executionId);
            expect(detail?.stepResults.map?.output).toEqual([
                { value: 'alpha', index: 0 },
                { value: 'beta', index: 1 },
                { value: 'gamma', index: 2 }
            ]);
            expect(detail?.stepResults.map?.attempts.map(attempt => attempt.itemIndex)).toEqual([0, 1, 2]);
            expect(detail?.stepResults.optional?.status).toBe('skipped');
            expect(detail?.stepResults.after?.status).toBe('success');

            await authenticatedRequest(app).get('/api/jobs/platform-workflow/plan').expect(200)
                .expect(response => {
                    const steps = response.body.levels.flatMap((level: { steps: unknown[] }) => level.steps);
                    expect(steps[0].foreach).toEqual({ ITEMS: 'input.items', MAX_CONCURRENCY: 4 });
                    expect(steps[1].when).toEqual({ PATH: 'input.runOptional' });
                });
            await authenticatedRequest(app).get('/api/platform/overview').expect(200)
                .expect(response => {
                    expect(response.body.jobs.total).toBe(1);
                    expect(response.body.executions.success24h).toBe(1);
                    expect(response.body.executions.successRate24h).toBe(100);
                    expect(response.body.executions.averageQueueLatencyMs24h).toBeTypeOf('number');
                    expect(response.body.workers).toEqual({
                        capacity: 1,
                        busy: 0,
                        available: 1,
                        utilizationPercent: 0
                    });
                });
            await authenticatedRequest(app).get('/api/platform/executors').expect(200)
                .expect(response => expect(response.body.items).toEqual(
                    expect.arrayContaining(['RESTAPI', 'SCRIPT', 'COMMAND', 'PYTHON'])
                ));
        } finally {
            await manager.shutdown(1_000);
        }
    });
});

describe('Security and authentication lifecycle', () => {
    it('defaults API access to denied, enforces origin policy, and protects cookie mutations with CSRF', async () => {
        const manager = new JobExecutionManager(executions, undefined, 1, 1000, security.secrets);
        const app = createApp({
            pool,
            jobs: new JobService(jobs, executions),
            executions,
            manager,
            security
        });

        await request(app).get('/api/jobs').expect(401)
            .expect('X-Content-Type-Options', 'nosniff')
            .expect(response => expect(response.body.code).toBe('AUTHENTICATION_REQUIRED'));
        await request(app).get('/api/jobs').set('Origin', 'https://evil.example').expect(403)
            .expect(response => expect(response.body.code).toBe('ORIGIN_NOT_ALLOWED'));
        await request(app).options('/api/jobs')
            .set('Origin', 'http://localhost:5173')
            .expect(204)
            .expect('Access-Control-Allow-Credentials', 'true');

        await request(app).post('/api/auth/login')
            .send({ email: ADMIN_EMAIL, password: 'wrong-password' })
            .expect(401)
            .expect(response => expect(response.body.code).toBe('INVALID_CREDENTIALS'));

        const browser = request.agent(app);
        const loginResponse = await browser.post('/api/auth/login')
            .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
            .expect(200);
        const cookies = loginResponse.headers['set-cookie'] as unknown as string[];
        expect(cookies.join(';')).toContain('HttpOnly');
        expect(cookies.join(';')).toContain('SameSite=Strict');
        const csrfToken = loginResponse.body.csrfToken as string;

        await browser.post('/api/jobs').send(job('csrf-denied', 'inactive')).expect(403)
            .expect(response => expect(response.body.code).toBe('CSRF_TOKEN_INVALID'));
        await browser.post('/api/jobs')
            .set('X-CSRF-Token', csrfToken)
            .send(job('csrf-allowed', 'inactive'))
            .expect(201);
        await browser.post('/api/auth/logout').set('X-CSRF-Token', csrfToken).expect(204);
        await browser.get('/api/auth/me').expect(401);
    });

    it('requires administrator-created users to replace temporary passwords before application access', async () => {
        const suffix = Date.now().toString();
        const email = 'temporary-' + suffix + '@integration.test';
        const temporaryPassword = 'temporary-password-12345';
        const permanentPassword = 'permanent-password-67890';
        await security.auth.createUser({ email, displayName: 'Temporary User', password: temporaryPassword, role: 'viewer' });
        const manager = new JobExecutionManager(executions, undefined, 1, 1000, security.secrets);
        const app = createApp({ pool, jobs: new JobService(jobs, executions), executions, manager, security });
        const browser = request.agent(app);
        const loginResponse = await browser.post('/api/auth/login').send({ email, password: temporaryPassword }).expect(200);
        expect(loginResponse.body.passwordChangeRequired).toBe(true);
        const csrfToken = loginResponse.body.csrfToken as string;
        await browser.get('/api/auth/me').expect(200).expect(response => expect(response.body.passwordChangeRequired).toBe(true));
        await browser.get('/api/jobs').expect(403).expect(response => expect(response.body.code).toBe('PASSWORD_CHANGE_REQUIRED'));
        await browser.get('/api/auth/tokens').expect(403).expect(response => expect(response.body.code).toBe('PASSWORD_CHANGE_REQUIRED'));
        await browser.post('/api/auth/password').set('X-CSRF-Token', csrfToken)
            .send({ currentPassword: temporaryPassword, newPassword: permanentPassword })
            .expect(204);
        await browser.get('/api/auth/me').expect(401);
        const permanentLogin = await browser.post('/api/auth/login').send({ email, password: permanentPassword }).expect(200);
        expect(permanentLogin.body.passwordChangeRequired).toBe(false);
        await browser.get('/api/jobs').expect(200);
    });

    it('lists and revokes user credentials, exposes lockouts, unlocks users, and audits administrator actions', async () => {
        const suffix = Date.now().toString();
        const email = 'access-' + suffix + '@integration.test';
        const password = 'access-user-password-12345';
        const user = await security.auth.createUser({ email, displayName: 'Access User', password, role: 'operator' }, false);
        const token = await security.auth.createApiToken({
            userId: user.userId,
            email: user.email,
            displayName: user.displayName,
            role: user.role,
            authType: 'session',
            credentialId: 'access-fixture',
            passwordChangeRequired: false
        }, { name: 'access-token' });
        const manager = new JobExecutionManager(executions, undefined, 1, 1000, security.secrets);
        const app = createApp({ pool, jobs: new JobService(jobs, executions), executions, manager, security });
        const browser = request.agent(app);
        await browser.post('/api/auth/login').send({ email, password }).expect(200);
        for (let attempt = 0; attempt < 5; attempt++) {
            await request(app).post('/api/auth/login').send({ email, password: 'incorrect-password-value' }).expect(401);
        }
        const users = await authenticatedRequest(app).get('/api/security/users').expect(200);
        expect(users.body.items.find((item: { userId: string }) => item.userId === user.userId)).toMatchObject({
            failedLoginAttempts: 5,
            passwordChangeRequired: false
        });
        expect(users.body.items.find((item: { userId: string }) => item.userId === user.userId).lockedUntil).toBeTypeOf('string');
        await authenticatedRequest(app).post('/api/security/users/' + user.userId + '/unlock').expect(200)
            .expect(response => expect(response.body.lockedUntil).toBeNull());
        await request(app).post('/api/auth/login').send({ email, password }).expect(200);

        const access = await authenticatedRequest(app).get('/api/security/users/' + user.userId + '/access').expect(200);
        expect(access.body.sessions.length).toBeGreaterThanOrEqual(2);
        expect(access.body.tokens).toEqual(expect.arrayContaining([expect.objectContaining({ tokenId: token.item.tokenId, name: 'access-token' })]));
        await authenticatedRequest(app)
            .delete('/api/security/users/' + user.userId + '/sessions/' + access.body.sessions[0].sessionId)
            .expect(204);
        await authenticatedRequest(app)
            .delete('/api/security/users/' + user.userId + '/tokens/' + token.item.tokenId)
            .expect(204);
        const revoked = await authenticatedRequest(app).post('/api/security/users/' + user.userId + '/revoke-access').expect(200);
        expect(revoked.body.sessionsRevoked).toBeGreaterThanOrEqual(1);
        const finalAccess = await authenticatedRequest(app).get('/api/security/users/' + user.userId + '/access').expect(200);
        expect(finalAccess.body.sessions).toEqual([]);
        expect(finalAccess.body.tokens[0].revokedAt).toBeTypeOf('string');
        await waitFor(async () => (await security.audit.list({ limit: 50, action: 'user.access_revoke' })).items.length > 0);
    });

    it('publishes the role matrix and safe read-only system status to administrators only', async () => {
        const manager = new JobExecutionManager(executions, undefined, 3, 750, security.secrets);
        const app = createApp({ pool, jobs: new JobService(jobs, executions), executions, manager, security });
        await authenticatedRequest(app).get('/api/security/roles').expect(200).expect(response => {
            expect(response.body.items.map((item: { role: string }) => item.role)).toEqual(['viewer', 'operator', 'admin']);
            expect(response.body.items.find((item: { role: string }) => item.role === 'admin').permissions).toContain('system:read');
        });
        await authenticatedRequest(app).get('/api/security/system').expect(200).expect(response => {
            expect(response.body.workers.concurrency).toBe(3);
            expect(response.body.database.schemaVersion).toBe(response.body.database.expectedSchemaVersion);
            expect(response.body.retention.mode).toBe('manual');
            expect(response.body.secrets.configured).toBe(true);
            expect(JSON.stringify(response.body)).not.toContain('postgres://');
            expect(JSON.stringify(response.body)).not.toContain(Buffer.alloc(32, 7).toString('base64'));
        });
    });

    it('enforces viewer/operator/admin permissions and persists execution actors', async () => {
        const suffix = Date.now().toString();
        const viewer = await security.auth.createUser({
            email: 'viewer-' + suffix + '@integration.test',
            displayName: 'Viewer',
            password: 'viewer-password-12345',
            role: 'viewer'
        }, false);
        const operator = await security.auth.createUser({
            email: 'operator-' + suffix + '@integration.test',
            displayName: 'Operator',
            password: 'operator-password-12345',
            role: 'operator'
        }, false);
        const viewerToken = (await security.auth.createApiToken({
            userId: viewer.userId,
            email: viewer.email,
            displayName: viewer.displayName,
            role: viewer.role,
            authType: 'session',
            credentialId: 'test-viewer',
            passwordChangeRequired: false
        }, { name: 'viewer-token' })).token;
        const operatorToken = (await security.auth.createApiToken({
            userId: operator.userId,
            email: operator.email,
            displayName: operator.displayName,
            role: operator.role,
            authType: 'session',
            credentialId: 'test-operator',
            passwordChangeRequired: false
        }, { name: 'operator-token' })).token;
        await jobs.create(job('rbac-job', 'inactive'));
        const manager = new JobExecutionManager(executions, undefined, 1, 1000, security.secrets);
        const app = createApp({
            pool,
            jobs: new JobService(jobs, executions),
            executions,
            manager,
            security
        });
        const viewerApi = request.agent(app).set('Authorization', 'Bearer ' + viewerToken);
        const operatorApi = request.agent(app).set('Authorization', 'Bearer ' + operatorToken);

        await viewerApi.get('/api/jobs').expect(200);
        await viewerApi.get('/api/attention').expect(200);
        await viewerApi.post('/api/attention/00000000-0000-4000-8000-000000000000/ignore').expect(403);
        await viewerApi.get('/api/security/audit?page=1&limit=25').expect(403);
        await viewerApi.get('/api/security/audit/export?format=json').expect(403);
        await viewerApi.get('/api/security/audit/1').expect(403);
        await viewerApi.get('/api/security/roles').expect(403);
        await viewerApi.get('/api/security/system').expect(403);
        await viewerApi.post('/api/jobs/rbac-job/run').expect(403);
        await operatorApi.post('/api/jobs').send(job('operator-cannot-write')).expect(403);
        const run = await operatorApi.post('/api/jobs/rbac-job/run').expect(202);
        expect(run.body.requestedAt).toBeTypeOf('string');
        const summary = await executions.getSummary(run.body.executionId as string);
        expect(summary?.requestedBy).toEqual({
            type: 'api_token',
            userId: operator.userId,
            label: operator.email
        });
        await operatorApi.post('/api/executions/' + run.body.executionId + '/cancel').expect(200);
        expect((await executions.getSummary(run.body.executionId as string))?.cancelRequestedBy?.label).toBe(operator.email);
        await authenticatedRequest(app).patch('/api/security/users/' + viewer.userId)
            .send({ status: 'disabled' })
            .expect(200);
        await viewerApi.get('/api/jobs').expect(401);
        await authenticatedRequest(app).patch('/api/security/users/' + adminUserId)
            .send({ role: 'viewer' })
            .expect(409)
            .expect(response => expect(response.body.code).toBe('LAST_ADMIN_REQUIRED'));
    });

    it('temporarily locks an identity after repeated invalid passwords without revealing account state', async () => {
        const suffix = Date.now().toString();
        const email = 'lockout-' + suffix + '@integration.test';
        await security.auth.createUser({
            email,
            displayName: 'Lockout Test',
            password: 'lockout-correct-password-123',
            role: 'viewer'
        });
        const manager = new JobExecutionManager(executions, undefined, 1, 1000, security.secrets);
        const app = createApp({
            pool,
            jobs: new JobService(jobs, executions),
            executions,
            manager,
            security
        });
        for (let attempt = 0; attempt < 5; attempt++) {
            await request(app).post('/api/auth/login')
                .send({ email, password: 'wrong-password-value' })
                .expect(401)
                .expect(response => expect(response.body).toEqual({
                    error: 'Email or password is incorrect.',
                    code: 'INVALID_CREDENTIALS'
                }));
        }
        await request(app).post('/api/auth/login')
            .send({ email, password: 'lockout-correct-password-123' })
            .expect(401)
            .expect(response => expect(response.body.code).toBe('INVALID_CREDENTIALS'));
    });

    it('encrypts managed secrets at rest and injects only referenced values at execution time', async () => {
        const secretValue = 'managed-secret-value-' + Date.now();
        const manager = new JobExecutionManager(executions, undefined, 1, 25, security.secrets);
        const app = createApp({
            pool,
            jobs: new JobService(jobs, executions),
            executions,
            manager,
            security
        });
        const api = authenticatedRequest(app);
        await api.put('/api/security/secrets/API_TOKEN')
            .send({ value: secretValue, description: 'Integration API token' })
            .expect(200);
        await api.get('/api/security/secrets').expect(200).expect(response => {
            expect(JSON.stringify(response.body)).not.toContain(secretValue);
            expect(response.body.items[0].name).toBe('API_TOKEN');
        });
        const stored = await pool.query<{ encrypted_value: Buffer }>(
            'SELECT encrypted_value FROM managed_secrets WHERE name = $1',
            ['API_TOKEN']
        );
        expect(stored.rows[0]?.encrypted_value.toString('utf8')).not.toContain(secretValue);

        let receivedSecret: string | undefined;
        const target = createServer((req, res) => {
            receivedSecret = req.headers['x-managed-secret'] as string | undefined;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ accepted: true }));
        });
        await new Promise<void>(resolve => target.listen(0, '127.0.0.1', resolve));
        const port = (target.address() as AddressInfo).port;
        const definition = job('secret-job', 'inactive');
        definition.STEPS[0] = {
            ORDER: 1,
            ID: 'only',
            NAME: 'Secret request',
            TYPE: 'RESTAPI',
            STEP_PARAMS: {
                URL: 'http://127.0.0.1:' + port + '/secret',
                HEADERS: { 'X-Managed-Secret': '{{secrets.API_TOKEN}}' }
            }
        };
        await jobs.create(definition);
        const queued = await executions.enqueueManual(definition.id);
        try {
            await manager.start();
            await waitFor(async () => (await executions.getSummary(queued.executionId))?.status === 'success');
            expect(receivedSecret).toBe(secretValue);
            expect(JSON.stringify(await executions.getDetail(queued.executionId))).not.toContain(secretValue);
        } finally {
            await manager.shutdown(1_000);
            await new Promise<void>(resolve => target.close(() => resolve()));
        }
    });

    it('tracks secret lifecycle ownership and exact job usage, then requires explicit force deletion', async () => {
        const name = 'LIFECYCLE_SECRET_' + Date.now();
        const definition = job('secret-usage-' + Date.now(), 'inactive');
        definition.STEPS[0]!.STEP_PARAMS = { TOKEN: `{{secrets.${name}}}` };
        definition.WEBHOOKS = [{ URL: 'https://example.test/hook', SIGNING_SECRET: name }];
        await jobs.create(definition);
        const manager = new JobExecutionManager(executions, undefined, 1, 1000, security.secrets);
        const app = createApp({ pool, jobs: new JobService(jobs, executions), executions, manager, security });
        const api = authenticatedRequest(app);
        const stored = await api.put('/api/security/secrets/' + name)
            .send({ value: 'write-only-lifecycle-value', description: 'Lifecycle test', ownerUserId: adminUserId })
            .expect(200);
        expect(stored.body).toMatchObject({
            name,
            owner: { userId: adminUserId },
            lastRotatedBy: { userId: adminUserId }
        });
        expect(stored.body.expiresOn).toBeTypeOf('string');
        expect(JSON.stringify(stored.body)).not.toContain('write-only-lifecycle-value');
        const usage = await api.get('/api/security/secrets/' + name + '/usage').expect(200);
        expect(usage.body.items).toEqual([expect.objectContaining({
            jobId: definition.id,
            references: expect.arrayContaining([
                expect.objectContaining({ kind: 'runtime_template' }),
                expect.objectContaining({ kind: 'webhook_signing' })
            ])
        })]);
        await api.delete('/api/security/secrets/' + name).expect(409)
            .expect(response => {
                expect(response.body.code).toBe('SECRET_IN_USE');
                expect(response.body.details.usage[0].jobId).toBe(definition.id);
            });
        await pool.query(`UPDATE managed_secrets SET expires_on = current_date - 1 WHERE name = $1`, [name]);
        await expect(security.secrets.resolve(name)).resolves.toBe('write-only-lifecycle-value');
        await api.delete('/api/security/secrets/' + name + '?force=true').expect(204);
        await waitFor(async () => {
            const history = await security.audit.list({ limit: 50, resourceType: 'secret', resourceId: name });
            return history.items.some(item => item.action === 'secret.delete');
        });
        await api.get('/api/security/audit?page=1&limit=25&resourceType=secret&resourceId=' + encodeURIComponent(name))
            .expect(200)
            .expect(response => {
                expect(response.body.items.length).toBeGreaterThan(0);
                expect(response.body.items.every((item: { resourceType: string; resourceId: string }) => item.resourceType === 'secret' && item.resourceId === name)).toBe(true);
            });
    });

    it('explores and exports filtered audit history with exact totals and full details', async () => {
        const action = 'integration.audit.' + Date.now();
        const actorLabel = 'Scheduler, "primary"';
        const from = new Date(Date.now() - 60_000).toISOString();
        for (let index = 0; index < 3; index++) {
            await security.audit.record({
                requestId: randomUUID(),
                actorType: 'system',
                actorLabel,
                action,
                outcome: 'success',
                statusCode: 201,
                resourceType: 'job',
                resourceId: 'audit-resource-' + index,
                ipAddress: '127.0.0.1',
                userAgent: 'integration-agent',
                metadata: { index, note: 'first line\nsecond line' }
            });
        }
        const to = new Date(Date.now() + 60_000).toISOString();
        const manager = new JobExecutionManager(executions, undefined, 1, 1000, security.secrets);
        const app = createApp({
            pool,
            jobs: new JobService(jobs, executions),
            executions,
            manager,
            security
        });
        const filter = [
            'action=' + encodeURIComponent(action),
            'actorType=system',
            'actorLabel=' + encodeURIComponent('primary'),
            'resource=' + encodeURIComponent('audit-resource'),
            'outcome=success',
            'from=' + encodeURIComponent(from),
            'to=' + encodeURIComponent(to)
        ].join('&');

        const firstPage = await authenticatedRequest(app)
            .get('/api/security/audit?' + filter + '&page=1&limit=2')
            .expect(200);
        expect(firstPage.body).toMatchObject({ page: 1, pageSize: 2, total: 3, totalPages: 2 });
        expect(firstPage.body.items).toHaveLength(2);
        const secondPage = await authenticatedRequest(app)
            .get('/api/security/audit?' + filter + '&page=2&limit=2')
            .expect(200);
        expect(secondPage.body.items).toHaveLength(1);
        await authenticatedRequest(app)
            .get('/api/security/audit?' + filter + '&page=99&limit=2')
            .expect(200)
            .expect(response => {
                expect(response.body.items).toEqual([]);
                expect(response.body).toMatchObject({ page: 99, total: 3, totalPages: 2 });
            });
        await authenticatedRequest(app)
            .get('/api/security/audit?' + filter + '&limit=2')
            .expect(200)
            .expect(response => expect(response.body.nextCursor).toBeTypeOf('string'));

        const detail = await authenticatedRequest(app)
            .get('/api/security/audit/' + firstPage.body.items[0].auditId)
            .expect(200);
        expect(detail.body).toMatchObject({
            actorType: 'system',
            actorLabel,
            action,
            outcome: 'success',
            statusCode: 201,
            resourceType: 'job',
            ipAddress: '127.0.0.1',
            userAgent: 'integration-agent'
        });
        expect(detail.body.requestId).toBeTypeOf('string');
        expect(detail.body.metadata).toHaveProperty('note', 'first line\nsecond line');

        const csv = await authenticatedRequest(app)
            .get('/api/security/audit/export?' + filter + '&format=csv')
            .expect(200)
            .expect('X-Audit-Export-Total', '3')
            .expect('X-Audit-Export-Truncated', 'false');
        expect(csv.text).toContain('"Scheduler, ""primary"""');
        expect(csv.text).toContain('audit-resource-');

        const json = await authenticatedRequest(app)
            .get('/api/security/audit/export?' + filter + '&format=json')
            .expect(200);
        expect(json.body.metadata).toEqual({ total: 3, exported: 3, truncated: false, limit: 10_000 });
        expect(json.body.items.map((item: { auditId: string }) => item.auditId)).toEqual([
            ...firstPage.body.items,
            ...secondPage.body.items
        ].map((item: { auditId: string }) => item.auditId));

        expect(await security.audit.listForExport({ action }, 2)).toMatchObject({
            total: 3,
            truncated: true
        });
        await authenticatedRequest(app).get('/api/security/audit?page=1&cursor=bad').expect(400)
            .expect(response => expect(response.body.code).toBe('CONFLICTING_PAGINATION'));
        await authenticatedRequest(app).get('/api/security/audit?page=0').expect(400)
            .expect(response => expect(response.body.code).toBe('INVALID_PAGE'));
        await authenticatedRequest(app).get('/api/security/audit?actorType=robot').expect(400)
            .expect(response => expect(response.body.code).toBe('INVALID_AUDIT_ACTOR_TYPE'));
        await authenticatedRequest(app).get('/api/security/audit?to=2026-01-01').expect(400)
            .expect(response => expect(response.body.code).toBe('INVALID_TO'));
        await authenticatedRequest(app).get('/api/security/audit?to=2026-02-30T00%3A00%3A00Z').expect(400)
            .expect(response => expect(response.body.code).toBe('INVALID_TO'));
        await authenticatedRequest(app).get('/api/security/audit/export?format=xml').expect(400)
            .expect(response => expect(response.body.code).toBe('INVALID_EXPORT_FORMAT'));
    });

    it('records actor-aware mutation audits and rejects audit mutation in PostgreSQL', async () => {
        const manager = new JobExecutionManager(executions, undefined, 1, 1000, security.secrets);
        const app = createApp({
            pool,
            jobs: new JobService(jobs, executions),
            executions,
            manager,
            security
        });
        await authenticatedRequest(app).post('/api/jobs').send(job('audited-job', 'inactive')).expect(201);
        await waitFor(async () => {
            const events = await security.audit.list({ limit: 50, action: 'job.create' });
            return events.items.some(item => item.resourceId === null || item.resourceId === 'audited-job');
        });
        const page = await authenticatedRequest(app).get('/api/security/audit?action=job.create').expect(200);
        expect(page.body.items.some((item: { actorLabel: string }) => item.actorLabel === ADMIN_EMAIL)).toBe(true);
        const auditId = page.body.items[0].auditId as string;
        await expect(pool.query(
            'UPDATE security_audit_events SET action = $2 WHERE id = $1',
            [auditId, 'tampered']
        )).rejects.toThrow(/append-only/u);
    });

    it('creates immutable job revisions, rejects stale HTTP edits, and rolls back without changing activation', async () => {
        const manager = new JobExecutionManager(executions, undefined, 1, 1000);
        const app = createApp({ pool, jobs: new JobService(jobs, executions), executions, manager, security });
        const original = job('versioned-job', 'inactive');
        const created = await authenticatedRequest(app).post('/api/jobs').send(original).expect(201);
        expect(created.body.version).toBe(1);
        await authenticatedRequest(app).put('/api/jobs/versioned-job').send({ ...original, name: 'No precondition' })
            .expect(428).expect(response => expect(response.body.code).toBe('JOB_VERSION_REQUIRED'));
        const updatedDefinition = { ...original, name: 'Updated definition', status: 'active' as const };
        const updated = await authenticatedRequest(app).put('/api/jobs/versioned-job').set('If-Match', '"1"')
            .send(updatedDefinition).expect(200);
        expect(updated.body).toMatchObject({ version: 2, name: 'Updated definition', status: 'active' });
        await authenticatedRequest(app).put('/api/jobs/versioned-job').set('If-Match', '"1"')
            .send(updatedDefinition).expect(409)
            .expect(response => expect(response.body).toMatchObject({ code: 'JOB_VERSION_CONFLICT', details: { currentVersion: 2 } }));
        await authenticatedRequest(app).get('/api/jobs/versioned-job/versions?page=1&limit=25').expect(200)
            .expect(response => expect(response.body).toMatchObject({ total: 2, items: [{ version: 2 }, { version: 1 }] }));
        const rolledBack = await authenticatedRequest(app).post('/api/jobs/versioned-job/rollback')
            .send({ targetVersion: 1, expectedVersion: 2 }).expect(200);
        expect(rolledBack.body).toMatchObject({ version: 3, name: original.name, status: 'active' });
        const queued = await executions.enqueueManual('versioned-job');
        expect(queued.jobVersion).toBe(3);
    });

    it('routes priority backlogs through registered worker queues and recovers expired leases', async () => {
        await jobs.create({ ...job('low-priority', 'inactive'), QUEUE: 'alpha', PRIORITY: -10 });
        await jobs.create({ ...job('high-priority', 'inactive'), QUEUE: 'alpha', PRIORITY: 50 });
        const low = await executions.enqueueManual('low-priority');
        const high = await executions.enqueueManual('high-priority');
        const repeatedHigh = await executions.enqueueManual('high-priority');
        const workers = new WorkerRepository(pool, 30_000);
        const workerId = await workers.register('integration-alpha', ['alpha'], 2);
        expect((await executions.claimOldestQueued(workerId, ['alpha'], 20_000))?.executionId).toBe(high.executionId);
        expect((await executions.claimOldestQueued(workerId, ['alpha'], 20_000))?.executionId).toBe(low.executionId);
        expect(await executions.claimOldestQueued(workerId, ['alpha'], 20_000)).toBeUndefined();
        expect((await workers.queues()).find(queue => queue.name === 'alpha')).toMatchObject({ queued: 1, running: 2 });
        await pool.query(`UPDATE executions SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = ANY($1::uuid[])`, [[high.executionId, low.executionId]]);
        expect(await executions.reconcileExpiredLeases()).toBe(2);
        expect((await executions.getSummary(high.executionId))?.error?.code).toBe('WORKER_LOST');
        expect((await executions.claimOldestQueued(workerId, ['alpha'], 20_000))?.executionId).toBe(repeatedHigh.executionId);
        expect((await workers.setDesiredState(workerId, 'draining')).desiredState).toBe('draining');
        expect((await workers.setDesiredState(workerId, 'accepting')).desiredState).toBe('accepting');
        const retiredWorkerId = await workers.register('retired-alpha', ['alpha'], 1);
        await pool.query(
            `UPDATE worker_instances SET last_heartbeat_at = clock_timestamp() - interval '10 days'
             WHERE id = $1`,
            [retiredWorkerId]
        );
        const detail = await workers.queueDetail('alpha') as { subscribedWorkers: Array<{ workerId: string }> };
        expect(detail.subscribedWorkers.map(worker => worker.workerId)).toEqual([workerId]);
        await pool.query(
            `UPDATE worker_instances SET last_heartbeat_at = clock_timestamp() - interval '10 days'
             WHERE id = $1`,
            [workerId]
        );
        const cutoff = new Date(Date.now() - 9 * 24 * 60 * 60 * 1_000);
        expect(await workers.countRetiredBefore(cutoff)).toBe(1);
        expect(await workers.deleteRetiredBefore(cutoff, 10)).toEqual([retiredWorkerId]);
    });

    it('authenticates idempotent webhooks and durably chains terminal job output without cycles', async () => {
        await jobs.create(job('event-source', 'active'));
        await jobs.create(job('event-target', 'active'));
        const automations = new AutomationRepository(pool, executions);
        const manager = new JobExecutionManager(executions, undefined, 1, 1000);
        const app = createApp({ pool, jobs: new JobService(jobs, executions), executions, manager, security, automations });
        const chain = await authenticatedRequest(app).post('/api/jobs/event-target/triggers')
            .send({ kind: 'job_completion', name: 'After source', sourceJobId: 'event-source', terminalStatuses: ['success'] })
            .expect(201);
        const source = await executions.enqueueManual('event-source', { accountId: 42 });
        expect((await executions.claimOldestQueued())?.executionId).toBe(source.executionId);
        await executions.stepFinished(source.executionId, { stepId: 'only', stepName: 'Only', stepType: 'SCRIPT', status: 'success', attempts: [], output: { ok: true } });
        await executions.finishExecution(source.executionId, 'success', null, null);
        expect(await automations.dispatchOne()).toBe(true);
        const chained = await executions.list({ jobId: 'event-target', trigger: 'job_completion', limit: 10 });
        expect(chained.items).toHaveLength(1);
        const chainedDetail = await executions.getDetail(chained.items[0]!.executionId);
        expect(chainedDetail?.input).toMatchObject({
            event: { triggerId: chain.body.triggerId, sourceExecutionId: source.executionId, status: 'success' },
            sourceInput: { accountId: 42 }, stepOutputs: { only: { ok: true } }
        });
        await authenticatedRequest(app).post('/api/jobs/event-source/triggers')
            .send({ kind: 'job_completion', name: 'Cycle', sourceJobId: 'event-target', terminalStatuses: ['success'] })
            .expect(409).expect(response => expect(response.body.code).toBe('AUTOMATION_CYCLE'));

        const webhook = await authenticatedRequest(app).post('/api/jobs/event-target/triggers')
            .send({ kind: 'webhook', name: 'Inbound test' }).expect(201);
        expect(webhook.body.token).toMatch(/^bj_hook_/u);
        const hookPath = '/hooks/' + webhook.body.trigger.triggerId;
        await request(app).post(hookPath).send({ hello: 'world' }).expect(401);
        const first = await request(app).post(hookPath).set('Authorization', 'Bearer ' + webhook.body.token)
            .set('Idempotency-Key', 'same-event').send({ hello: 'world' }).expect(202);
        const duplicate = await request(app).post(hookPath).set('Authorization', 'Bearer ' + webhook.body.token)
            .set('Idempotency-Key', 'same-event').send({ hello: 'world' }).expect(202);
        expect(duplicate.body.executionId).toBe(first.body.executionId);
        const stored = await pool.query<{ token_hash: Buffer }>('SELECT token_hash FROM automation_triggers WHERE id = $1', [webhook.body.trigger.triggerId]);
        expect(stored.rows[0]?.token_hash.toString('utf8')).not.toContain(webhook.body.token);
        await jobs.setStatuses(['event-target'], 'inactive');
        await request(app).post(hookPath).set('Authorization', 'Bearer ' + webhook.body.token)
            .send({ hello: 'later' }).expect(409).expect(response => expect(response.body.code).toBe('JOB_INACTIVE'));
    });

    it('validates defaults, deduplicates manual runs, resumes replay-safe steps, and exposes operations APIs', async () => {
        const definition: Job = {
            ...job('expanded-api', 'inactive'),
            INPUT_SCHEMA: {
                type: 'object',
                additionalProperties: false,
                required: ['account', 'count'],
                properties: {
                    account: { type: 'string' },
                    count: { type: 'integer', minimum: 1 }
                }
            },
            DEFAULT_INPUT: { account: 'primary', count: 2 },
            STEPS: [
                { ORDER: 1, ID: 'prepare', NAME: 'Prepare', TYPE: 'SCRIPT', STEP_PARAMS: { CODE: '() => ({ prepared: true })' } },
                { ORDER: 2, ID: 'deliver', NAME: 'Deliver', TYPE: 'SCRIPT', DEPENDS_ON: ['prepare'], REPLAY_SAFE: true, STEP_PARAMS: { CODE: '() => ({ delivered: true })' } }
            ]
        };
        const manager = new JobExecutionManager(executions, undefined, 1, 1000);
        const app = createApp({ pool, jobs: new JobService(jobs, executions), executions, manager, security });
        const api = authenticatedRequest(app);
        await api.post('/api/jobs').send(definition).expect(201);
        await api.post('/api/jobs/expanded-api/run/validate').send({}).expect(200)
            .expect(response => expect(response.body.input).toEqual({ account: 'primary', count: 2 }));
        await api.post('/api/jobs/expanded-api/run/validate').send({ input: { count: 3 } }).expect(422)
            .expect(response => expect(response.body.code).toBe('EXECUTION_INPUT_SCHEMA_FAILED'));

        const first = await api.post('/api/jobs/expanded-api/run').set('Idempotency-Key', 'manual-once').send({}).expect(202);
        const duplicate = await api.post('/api/jobs/expanded-api/run').set('Idempotency-Key', 'manual-once').send({}).expect(202);
        expect(duplicate.body.executionId).toBe(first.body.executionId);
        await api.post('/api/jobs/expanded-api/run').set('Idempotency-Key', 'manual-once')
            .send({ input: { account: 'other', count: 1 } }).expect(409)
            .expect(response => expect(response.body.code).toBe('IDEMPOTENCY_KEY_REUSED'));

        expect((await executions.claimOldestQueued())?.executionId).toBe(first.body.executionId);
        await executions.stepFinished(first.body.executionId, {
            stepId: 'prepare', stepName: 'Prepare', stepType: 'SCRIPT', status: 'success', attempts: [], output: { prepared: true }
        });
        await executions.stepFinished(first.body.executionId, {
            stepId: 'deliver', stepName: 'Deliver', stepType: 'SCRIPT', status: 'failed', attempts: [],
            errorCode: 'DELIVERY_FAILED', error: 'Delivery failed'
        });
        await executions.finishExecution(first.body.executionId, 'failed', 'DELIVERY_FAILED', 'Delivery failed');
        const resumed = await api.post('/api/executions/' + first.body.executionId + '/replay')
            .send({ resumeStepId: 'deliver' }).expect(202);
        const resumedDetail = await executions.getDetail(resumed.body.executionId as string);
        expect(resumedDetail).toMatchObject({
            trigger: 'replay',
            replaySourceExecutionId: first.body.executionId,
            resumeStepId: 'deliver',
            stepResults: { prepare: { status: 'reused', output: { prepared: true } }, deliver: { status: 'pending' } }
        });

        const testRun = await api.post('/api/jobs/test-run').send({ job: definition, stepId: 'deliver' }).expect(202);
        expect(testRun.body).toMatchObject({ trigger: 'test', testSelectedStepId: 'deliver', suppressSideEffects: true });
        await api.get('/api/platform/executor-catalog').expect(200)
            .expect(response => expect(response.body.items.some((item: { type: string }) => item.type === 'SCRIPT')).toBe(true));
        const activity = await api.get('/api/platform/activity?window=6h').expect(200);
        expect(activity.body).toMatchObject({ window: '6h', startsAt: expect.any(String), generatedAt: expect.any(String) });
        const populatedBucket = activity.body.buckets.find((bucket: { requested: number }) => bucket.requested > 0) as { at: string; requested: number } | undefined;
        expect(populatedBucket).toBeDefined();
        const exactFrom = new Date(Math.max(Date.parse(populatedBucket!.at), Date.parse(activity.body.startsAt))).toISOString();
        const exactTo = new Date(Math.min(Date.parse(populatedBucket!.at) + activity.body.bucketMs, Date.parse(activity.body.generatedAt))).toISOString();
        const matchingLogs = await api.get('/api/executions').query({ from: exactFrom, to: exactTo, page: 1, limit: 100 }).expect(200);
        expect(matchingLogs.body.total).toBe(populatedBucket!.requested);
        await api.get('/api/platform/search?q=expanded').expect(200)
            .expect(response => expect(response.body.jobs[0]).toMatchObject({ id: 'expanded-api' }));

        const scheduledDefinition = { ...job('backfill-dedup', 'active'), schedule: '0 * * * * *' };
        const scheduledJob = await api.post('/api/jobs').send(scheduledDefinition).expect(201);
        const scheduledFor = new Date(scheduledJob.body.next_run as string);
        const backfill = await api.post('/api/jobs/backfill-dedup/backfills')
            .set('Idempotency-Key', 'backfill-once')
            .send({ from: new Date(scheduledFor.getTime() - 1_000).toISOString(), to: scheduledFor.toISOString() })
            .expect(202);
        expect(backfill.body.executions).toHaveLength(1);
        const duplicateBackfill = await api.post('/api/jobs/backfill-dedup/backfills')
            .set('Idempotency-Key', 'backfill-once')
            .send({ from: new Date(scheduledFor.getTime() - 1_000).toISOString(), to: scheduledFor.toISOString() })
            .expect(202);
        expect(duplicateBackfill.body).toEqual(backfill.body);
        expect(await executions.processDueJobs(new Date(scheduledFor.getTime() + 1_000))).toBe(1);
        const occurrenceCount = await pool.query<{ count: string }>(
            `SELECT count(*)::text AS count FROM executions WHERE job_id = 'backfill-dedup' AND scheduled_for = $1`,
            [scheduledFor]
        );
        expect(occurrenceCount.rows[0]?.count).toBe('1');

        const queue = await api.get('/api/queues/default').expect(200);
        await api.patch('/api/queues/default').set('If-Match', String(queue.body.policy.version))
            .send({ paused: true, maxRunning: 2, maxStarts: 3, intervalMs: 60_000 }).expect(200)
            .expect(response => expect(response.body).toMatchObject({ paused: true, maxRunning: 2, maxStarts: 3, intervalMs: 60_000 }));
    });

    it('matches incident notifications, signs durable deliveries, retries failures, and prevents alert loops', async () => {
        const suffix = Date.now().toString();
        const endpointSecret = 'NOTIFY_ENDPOINT_' + suffix;
        const signingSecret = 'NOTIFY_SIGNING_' + suffix;
        await security.secrets.put(endpointSecret, 'https://notifications.example.test/hook', 'Notification endpoint', adminUserId);
        await security.secrets.put(signingSecret, 'integration-signing-key', 'Notification signing key', adminUserId);
        const notifications = new NotificationRepository(pool);
        const manager = new JobExecutionManager(executions, undefined, 1, 1000);
        const failedRequests: Array<{ headers: HeadersInit | undefined; body: BodyInit | null | undefined }> = [];
        const dispatcher = new NotificationDispatcher(notifications, security.secrets, {
            pollMs: 10_000,
            maxAttempts: 1,
            fetchImplementation: async (_url, init) => {
                failedRequests.push({ headers: init?.headers, body: init?.body });
                return new Response('unavailable', { status: 503 });
            }
        });
        const app = createApp({
            pool, jobs: new JobService(jobs, executions), executions, manager, security,
            notifications, notificationDispatcher: dispatcher
        });
        const api = authenticatedRequest(app);
        const channel = await api.post('/api/notifications/channels').send({
            name: 'Signed operations webhook',
            kind: 'generic_webhook',
            endpointSecretName: endpointSecret,
            signingSecretName: signingSecret,
            enabled: true
        }).expect(201);
        await api.post('/api/notifications/policies').send({
            name: 'High failures',
            channelId: channel.body.channelId,
            enabled: true,
            incidentKinds: ['execution_failure'],
            minimumSeverity: 'high',
            jobIds: ['notification-failure'],
            lifecycleEvents: ['opened', 'reopened', 'severity_increased', 'resolved']
        }).expect(201);
        await jobs.create(job('notification-failure', 'inactive'));
        const failed = await executions.enqueueManual('notification-failure');
        expect((await executions.claimOldestQueued())?.executionId).toBe(failed.executionId);
        await executions.finishExecution(failed.executionId, 'failed', 'NOTIFICATION_TEST', 'Execution failed');
        expect((await notifications.listDeliveries())[0]).toMatchObject({ status: 'pending', attemptCount: 0 });

        await dispatcher.start();
        await dispatcher.shutdown();
        const delivery = (await notifications.listDeliveries())[0]!;
        expect(delivery).toMatchObject({ status: 'failed', attemptCount: 1, responseStatus: 503 });
        expect(failedRequests).toHaveLength(1);
        const headers = new Headers(failedRequests[0]!.headers);
        expect(headers.get('X-Workline-Signature')).toMatch(/^sha256=[0-9a-f]{64}$/u);
        expect(headers.get('X-Workline-Timestamp')).toMatch(/^\d+$/u);
        expect((await pool.query<{ count: string }>('SELECT count(*)::text AS count FROM operational_attention_items')).rows[0]?.count).toBe('1');

        await api.post('/api/notifications/deliveries/' + delivery.deliveryId + '/retry').expect(200)
            .expect(response => expect(response.body.status).toBe('pending'));
        await api.patch('/api/notifications/channels/' + channel.body.channelId)
            .set('If-Match', '"' + channel.body.version + '"').send({ enabled: false }).expect(200);
        await api.patch('/api/notifications/policies/00000000-0000-4000-8000-000000000001')
            .set('If-Match', '1').send({ minimumSeverity: 'urgent' }).expect(422);
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

function authenticatedRequest(app: Express) {
    return request.agent(app).set('Authorization', 'Bearer ' + adminToken);
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('Timed out waiting for execution state.');
}
