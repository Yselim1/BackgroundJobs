import { randomUUID } from 'node:crypto';
import type { DatabasePool } from '../db/pool.js';
import { AppError } from '../errors.js';
import type { AuthenticatedActor, QueuePolicy, QueueSummary, WorkerInstance } from '../types/index.js';
import { withTransaction } from '../db/pool.js';

interface WorkerRow {
    id: string;
    name: string;
    queues: string[];
    concurrency: number;
    desired_state: 'accepting' | 'draining';
    started_at: Date;
    last_heartbeat_at: Date;
    stopped_at: Date | null;
    running: string | number;
    stale: boolean;
}

interface QueuePolicyRow { name: string; paused: boolean; max_running: number | null; max_starts: number | null; interval_ms: number | null; version: number; updated_at: Date; }

export class WorkerRepository {
    constructor(readonly pool: DatabasePool, private readonly staleMs = 30_000) {}
    get staleAfterMs(): number { return this.staleMs; }

    async register(name: string, queues: string[], concurrency: number): Promise<string> {
        const workerId = randomUUID();
        await withTransaction(this.pool, async client => {
            await client.query(
                `INSERT INTO worker_instances(id, name, queues, concurrency) VALUES ($1, $2, $3, $4)`,
                [workerId, name, queues, concurrency]
            );
            await client.query(`INSERT INTO queue_policies(name) SELECT unnest($1::text[]) ON CONFLICT DO NOTHING`, [queues]);
        });
        return workerId;
    }

    async heartbeat(workerId: string, leaseMs: number): Promise<{ desiredState: 'accepting' | 'draining'; cancellations: string[] }> {
        const worker = await this.pool.query<{ desired_state: 'accepting' | 'draining' }>(
            `UPDATE worker_instances SET last_heartbeat_at = clock_timestamp()
             WHERE id = $1 AND stopped_at IS NULL RETURNING desired_state`, [workerId]
        );
        if (worker.rows[0] === undefined) throw new AppError('WORKER_NOT_FOUND', `Worker ${workerId} was not found.`, 404);
        const renewed = await this.pool.query<{ id: string; cancel_requested_at: Date | null }>(
            `UPDATE executions SET lease_expires_at = clock_timestamp() + ($2::integer * interval '1 millisecond')
             WHERE claimed_by_worker_id = $1 AND status = 'running'
             RETURNING id, cancel_requested_at`, [workerId, leaseMs]
        );
        return {
            desiredState: worker.rows[0].desired_state,
            cancellations: renewed.rows.filter(row => row.cancel_requested_at !== null).map(row => row.id)
        };
    }

    async stop(workerId: string): Promise<void> {
        await this.pool.query(
            `UPDATE worker_instances SET desired_state = 'draining', stopped_at = clock_timestamp(),
                last_heartbeat_at = clock_timestamp() WHERE id = $1`, [workerId]
        );
    }

    async setDesiredState(workerId: string, desired: 'accepting' | 'draining'): Promise<WorkerInstance> {
        const current = await this.pool.query<{ stale: boolean; stopped_at: Date | null }>(
            `SELECT stopped_at,
                last_heartbeat_at < clock_timestamp() - ($2::integer * interval '1 millisecond') AS stale
             FROM worker_instances WHERE id = $1`, [workerId, this.staleMs]
        );
        if (current.rows[0] === undefined) throw new AppError('WORKER_NOT_FOUND', `Worker ${workerId} was not found.`, 404);
        if (current.rows[0].stale || current.rows[0].stopped_at !== null) {
            throw new AppError('WORKER_OFFLINE', 'Offline workers cannot be drained or resumed.', 409);
        }
        await this.pool.query('UPDATE worker_instances SET desired_state = $2 WHERE id = $1', [workerId, desired]);
        return (await this.list()).find(worker => worker.workerId === workerId)!;
    }

    async list(): Promise<WorkerInstance[]> {
        const result = await this.pool.query<WorkerRow>(
            `SELECT w.*,
                count(e.id) FILTER (WHERE e.status = 'running')::integer AS running,
                w.last_heartbeat_at < clock_timestamp() - ($1::integer * interval '1 millisecond') AS stale
             FROM worker_instances w
             LEFT JOIN executions e ON e.claimed_by_worker_id = w.id AND e.status = 'running'
             GROUP BY w.id ORDER BY w.started_at DESC`, [this.staleMs]
        );
        return result.rows.map(row => ({
            workerId: row.id,
            name: row.name,
            queues: row.queues,
            concurrency: row.concurrency,
            desiredState: row.desired_state,
            state: row.stopped_at !== null ? 'stopped' : row.stale ? 'offline'
                : row.desired_state === 'accepting' ? 'online' : Number(row.running) === 0 ? 'drained' : 'draining',
            running: Number(row.running),
            startedAt: row.started_at.toISOString(),
            lastHeartbeatAt: row.last_heartbeat_at.toISOString(),
            stoppedAt: row.stopped_at?.toISOString() ?? null
        }));
    }

    async countRetiredBefore(cutoff: Date): Promise<number> {
        const result = await this.pool.query<{ count: string }>(
            `SELECT count(*)::text AS count
             FROM worker_instances w
             WHERE w.last_heartbeat_at < $1
               AND NOT EXISTS (
                   SELECT 1 FROM executions e
                   WHERE e.claimed_by_worker_id = w.id AND e.status = 'running'
               )`,
            [cutoff]
        );
        return Number(result.rows[0]?.count ?? 0);
    }

    async deleteRetiredBefore(cutoff: Date, limit: number): Promise<string[]> {
        const result = await this.pool.query<{ id: string }>(
            `WITH candidates AS (
                SELECT w.id
                FROM worker_instances w
                WHERE w.last_heartbeat_at < $1
                  AND NOT EXISTS (
                      SELECT 1 FROM executions e
                      WHERE e.claimed_by_worker_id = w.id AND e.status = 'running'
                  )
                ORDER BY w.last_heartbeat_at, w.id
                LIMIT $2
             )
             DELETE FROM worker_instances w USING candidates
             WHERE w.id = candidates.id
             RETURNING w.id`,
            [cutoff, limit]
        );
        return result.rows.map(row => row.id);
    }

    async queues(): Promise<QueueSummary[]> {
        const [executionRows, workers, policies] = await Promise.all([
            this.pool.query<{ name: string; queued: string; running: string }>(
                `SELECT queue_name AS name,
                    count(*) FILTER (WHERE status = 'queued')::text AS queued,
                    count(*) FILTER (WHERE status = 'running')::text AS running
                 FROM executions WHERE status IN ('queued', 'running') GROUP BY queue_name`
            ),
            this.list(),
            this.pool.query<{ name: string }>('SELECT name FROM queue_policies')
        ]);
        const names = new Set<string>(['default']);
        executionRows.rows.forEach(row => names.add(row.name));
        policies.rows.forEach(row => names.add(row.name));
        workers.filter(worker => worker.state !== 'offline' && worker.state !== 'stopped')
            .forEach(worker => worker.queues.forEach(queue => names.add(queue)));
        return [...names].sort().map(name => {
            const executions = executionRows.rows.find(row => row.name === name);
            const subscribed = workers.filter(worker => worker.state !== 'offline' && worker.state !== 'stopped' && worker.queues.includes(name));
            return { name, queued: Number(executions?.queued ?? 0), running: Number(executions?.running ?? 0),
                workers: subscribed.length, capacity: subscribed.reduce((sum, worker) => sum + worker.concurrency, 0) };
        });
    }

    async getQueuePolicy(name: string): Promise<QueuePolicy> {
        await this.pool.query('INSERT INTO queue_policies(name) VALUES ($1) ON CONFLICT DO NOTHING', [name]);
        const result = await this.pool.query<QueuePolicyRow>('SELECT * FROM queue_policies WHERE name = $1', [name]);
        return mapQueuePolicy(result.rows[0]!);
    }

    async updateQueuePolicy(
        name: string,
        patch: { paused?: boolean; maxRunning?: number | null; maxStarts?: number | null; intervalMs?: number | null },
        expectedVersion: number,
        actor: AuthenticatedActor
    ): Promise<QueuePolicy> {
        return withTransaction(this.pool, async client => {
            await client.query('INSERT INTO queue_policies(name) VALUES ($1) ON CONFLICT DO NOTHING', [name]);
            const current = await client.query<QueuePolicyRow>('SELECT * FROM queue_policies WHERE name = $1 FOR UPDATE', [name]);
            const row = current.rows[0]!;
            if (row.version !== expectedVersion) {
                throw new AppError('QUEUE_POLICY_VERSION_CONFLICT', `Queue policy ${name} is at version ${row.version}.`, 409, { currentVersion: row.version });
            }
            const next = {
                paused: patch.paused ?? row.paused,
                maxRunning: patch.maxRunning === undefined ? row.max_running : patch.maxRunning,
                maxStarts: patch.maxStarts === undefined ? row.max_starts : patch.maxStarts,
                intervalMs: patch.intervalMs === undefined ? row.interval_ms : patch.intervalMs
            };
            if ((next.maxStarts === null) !== (next.intervalMs === null)) {
                throw new AppError('INVALID_QUEUE_RATE_POLICY', 'maxStarts and intervalMs must both be set or both be null.', 422);
            }
            const updated = await client.query<QueuePolicyRow>(
                `UPDATE queue_policies SET paused = $2, max_running = $3, max_starts = $4, interval_ms = $5,
                    version = version + 1, updated_by_user_id = $6, updated_at = clock_timestamp()
                 WHERE name = $1 RETURNING *`,
                [name, next.paused, next.maxRunning, next.maxStarts, next.intervalMs, actor.userId]
            );
            return mapQueuePolicy(updated.rows[0]!);
        });
    }

    async queueDetail(name: string): Promise<Record<string, unknown>> {
        const [summaries, policy, subscribed, oldest, jobs, executions] = await Promise.all([
            this.queues(), this.getQueuePolicy(name), this.list(),
            this.pool.query<{ requested_at: Date | null }>(
                `SELECT min(requested_at) AS requested_at FROM executions WHERE queue_name = $1 AND status = 'queued'`, [name]
            ),
            this.pool.query<{ id: string; name: string }>(
                `SELECT id, definition->>'name' AS name FROM jobs WHERE coalesce(definition->>'QUEUE', 'default') = $1 ORDER BY id`, [name]
            ),
            this.pool.query<{ id: string; job_id: string; status: string; trigger_type: string; requested_at: Date; started_at: Date | null; finished_at: Date | null }>(
                `SELECT id, job_id, status, trigger_type, requested_at, started_at, finished_at
                 FROM executions WHERE queue_name = $1 ORDER BY requested_at DESC LIMIT 25`, [name]
            )
        ]);
        const summary = summaries.find(item => item.name === name) ?? { name, queued: 0, running: 0, workers: 0, capacity: 0 };
        const oldestAt = oldest.rows[0]?.requested_at ?? null;
        return {
            ...summary, policy,
            saturation: policy.maxRunning === null ? null : summary.running / policy.maxRunning,
            oldestQueuedAt: oldestAt?.toISOString() ?? null,
            oldestQueuedAgeMs: oldestAt === null ? null : Math.max(0, Date.now() - oldestAt.getTime()),
            subscribedWorkers: subscribed.filter(worker =>
                worker.state !== 'offline' && worker.state !== 'stopped' && worker.queues.includes(name)
            ),
            affectedJobs: jobs.rows,
            recentExecutions: executions.rows.map(row => ({
                executionId: row.id, jobId: row.job_id, status: row.status, trigger: row.trigger_type,
                requestedAt: row.requested_at.toISOString(), startedAt: row.started_at?.toISOString() ?? null,
                finishedAt: row.finished_at?.toISOString() ?? null
            }))
        };
    }
}

function mapQueuePolicy(row: QueuePolicyRow): QueuePolicy {
    return { name: row.name, paused: row.paused, maxRunning: row.max_running, maxStarts: row.max_starts,
        intervalMs: row.interval_ms, version: row.version, updatedAt: row.updated_at.toISOString() };
}
