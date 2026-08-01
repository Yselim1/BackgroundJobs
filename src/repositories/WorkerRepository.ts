import { randomUUID } from 'node:crypto';
import type { DatabasePool } from '../db/pool.js';
import { AppError } from '../errors.js';
import type { QueueSummary, WorkerInstance } from '../types/index.js';

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

export class WorkerRepository {
    constructor(readonly pool: DatabasePool, private readonly staleMs = 30_000) {}
    get staleAfterMs(): number { return this.staleMs; }

    async register(name: string, queues: string[], concurrency: number): Promise<string> {
        const workerId = randomUUID();
        await this.pool.query(
            `INSERT INTO worker_instances(id, name, queues, concurrency) VALUES ($1, $2, $3, $4)`,
            [workerId, name, queues, concurrency]
        );
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

    async queues(): Promise<QueueSummary[]> {
        const [executionRows, workers] = await Promise.all([
            this.pool.query<{ name: string; queued: string; running: string }>(
                `SELECT queue_name AS name,
                    count(*) FILTER (WHERE status = 'queued')::text AS queued,
                    count(*) FILTER (WHERE status = 'running')::text AS running
                 FROM executions WHERE status IN ('queued', 'running') GROUP BY queue_name`
            ),
            this.list()
        ]);
        const names = new Set<string>(['default']);
        executionRows.rows.forEach(row => names.add(row.name));
        workers.filter(worker => worker.state !== 'offline' && worker.state !== 'stopped')
            .forEach(worker => worker.queues.forEach(queue => names.add(queue)));
        return [...names].sort().map(name => {
            const executions = executionRows.rows.find(row => row.name === name);
            const subscribed = workers.filter(worker => worker.state !== 'offline' && worker.state !== 'stopped' && worker.queues.includes(name));
            return { name, queued: Number(executions?.queued ?? 0), running: Number(executions?.running ?? 0),
                workers: subscribed.length, capacity: subscribed.reduce((sum, worker) => sum + worker.concurrency, 0) };
        });
    }
}
