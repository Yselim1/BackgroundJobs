import { Router, type NextFunction, type Request, type Response } from 'express';
import type { DatabasePool } from '../db/pool.js';
import { ExecutorRegistry } from '../executors/ExecutorRegistry.js';
import { AttentionRepository } from '../repositories/AttentionRepository.js';
import { AppError } from '../errors.js';

interface CountRow { count: string; }
interface StatusCountRow { status: string; count: string; }
export function createPlatformController(pool: DatabasePool, workerConcurrency = 4, workerStaleMs = 30_000): Router {
    const router = Router();
    const attention = new AttentionRepository(pool);

    router.get('/overview', route(async (_req, res) => {
        const [clock, jobs, executions, webhooks, duration, operations, fleet, durableAttention] = await Promise.all([
            pool.query<{ now: Date }>('SELECT clock_timestamp() AS now'),
            pool.query<StatusCountRow>('SELECT status, count(*)::text AS count FROM jobs GROUP BY status'),
            pool.query<StatusCountRow>(
                `SELECT status, count(*)::text AS count
                 FROM executions
                 WHERE status IN ('queued', 'running') OR requested_at >= clock_timestamp() - interval '24 hours'
                 GROUP BY status`
            ),
            pool.query<StatusCountRow>(
                `SELECT status, count(*)::text AS count
                 FROM webhook_deliveries
                 WHERE status IN ('pending', 'delivering', 'failed')
                 GROUP BY status`
            ),
            pool.query<CountRow & { average_ms: string | null }>(
                `SELECT count(*)::text AS count, round(avg(duration_ms))::text AS average_ms
                 FROM executions
                 WHERE status = 'success' AND requested_at >= clock_timestamp() - interval '24 hours'`
            ),
            pool.query<{
                average_queue_ms: string | null;
                oldest_queued_ms: string | null;
                success_count: string;
                failed_count: string;
            }>(
                `SELECT
                    round(avg(extract(epoch FROM (started_at - requested_at)) * 1000)
                        FILTER (WHERE started_at IS NOT NULL AND requested_at >= clock_timestamp() - interval '24 hours'))::text AS average_queue_ms,
                    round(extract(epoch FROM (
                        clock_timestamp() - min(requested_at) FILTER (WHERE status = 'queued')
                    )) * 1000)::text AS oldest_queued_ms,
                    count(*) FILTER (WHERE status = 'success' AND requested_at >= clock_timestamp() - interval '24 hours')::text AS success_count,
                    count(*) FILTER (WHERE status = 'failed' AND requested_at >= clock_timestamp() - interval '24 hours')::text AS failed_count
                 FROM executions`
            ),
            pool.query<{ capacity: string }>(
                `SELECT coalesce(sum(concurrency), 0)::text AS capacity FROM worker_instances
                 WHERE stopped_at IS NULL
                   AND last_heartbeat_at >= clock_timestamp() - ($1::integer * interval '1 millisecond')`,
                [workerStaleMs]
            ),
            attention.openOverview()
        ]);
        const jobCounts = statusMap(jobs.rows);
        const executionCounts = statusMap(executions.rows);
        const webhookCounts = statusMap(webhooks.rows);
        const running = executionCounts.running ?? 0;
        const successCount = Number(operations.rows[0]?.success_count ?? 0);
        const failedCount = Number(operations.rows[0]?.failed_count ?? 0);
        const terminalCount = successCount + failedCount;
        const liveCapacity = Number(fleet.rows[0]?.capacity ?? 0) || workerConcurrency;
        res.status(200).json({
            generatedAt: clock.rows[0]!.now.toISOString(),
            jobs: {
                total: (jobCounts.active ?? 0) + (jobCounts.inactive ?? 0),
                active: jobCounts.active ?? 0,
                inactive: jobCounts.inactive ?? 0
            },
            executions: {
                queued: executionCounts.queued ?? 0,
                running: executionCounts.running ?? 0,
                success24h: executionCounts.success ?? 0,
                failed24h: executionCounts.failed ?? 0,
                cancelled24h: executionCounts.cancelled ?? 0,
                skipped24h: executionCounts.skipped ?? 0,
                successRate24h: terminalCount === 0
                    ? null
                    : Math.round(successCount / terminalCount * 1000) / 10,
                averageQueueLatencyMs24h: operations.rows[0]?.average_queue_ms === null
                    ? null
                    : Number(operations.rows[0]?.average_queue_ms ?? 0),
                oldestQueuedAgeMs: operations.rows[0]?.oldest_queued_ms === null
                    ? null
                    : Number(operations.rows[0]?.oldest_queued_ms ?? 0),
                averageSuccessDurationMs24h: duration.rows[0]?.average_ms === null
                    ? null
                    : Number(duration.rows[0]?.average_ms ?? 0)
            },
            webhooks: {
                pending: webhookCounts.pending ?? 0,
                delivering: webhookCounts.delivering ?? 0,
                failed: webhookCounts.failed ?? 0
            },
            workers: {
                capacity: liveCapacity,
                busy: running,
                available: Math.max(0, liveCapacity - running),
                utilizationPercent: Math.round(Math.min(1, running / liveCapacity) * 1000) / 10
            },
            attention: {
                openExecutionFailures: durableAttention.executionCount,
                openWebhookFailures: durableAttention.webhookCount,
                failedExecutions: durableAttention.failedExecutions,
                failedWebhooks: durableAttention.failedWebhooks
            }
        });
    }));

    router.get('/executors', (_req, res) => {
        res.status(200).json({ items: ExecutorRegistry.getSupportedTypes() });
    });

    router.get('/executor-catalog', (_req, res) => {
        res.status(200).json({ items: ExecutorRegistry.getCatalog() });
    });

    router.get('/activity', route(async (req, res) => {
        const window = typeof req.query.window === 'string' ? req.query.window : '24h';
        const settings = window === '6h' ? { hours: 6, bucketMs: 15 * 60_000 }
            : window === '24h' ? { hours: 24, bucketMs: 60 * 60_000 }
                : window === '7d' ? { hours: 7 * 24, bucketMs: 6 * 60 * 60_000 }
                    : undefined;
        if (settings === undefined) throw new AppError('INVALID_ACTIVITY_WINDOW', 'window must be 6h, 24h, or 7d.', 400);
        const result = await pool.query<{
            bucket: Date;
            requested: string;
            successful: string;
            failed: string;
            starts_at: Date;
            generated_at: Date;
            p50_duration_ms: string | null;
            p95_duration_ms: string | null;
            average_queue_delay_ms: string | null;
        }>(
            `WITH bounds AS (
                SELECT generated_at,
                       generated_at - ($1::integer * interval '1 hour') AS starts_at
                FROM (SELECT date_trunc('milliseconds', clock_timestamp()) AS generated_at) AS activity_clock
             ), buckets AS (
                SELECT generate_series(
                    to_timestamp(floor(extract(epoch FROM starts_at) * 1000 / $2) * $2 / 1000.0),
                    to_timestamp(floor(extract(epoch FROM generated_at) * 1000 / $2) * $2 / 1000.0),
                    $2::integer * interval '1 millisecond'
                ) AS bucket FROM bounds
             ), activity AS (
                SELECT to_timestamp(floor(extract(epoch FROM requested_at) * 1000 / $2) * $2 / 1000.0) AS bucket,
                       count(*)::text AS requested,
                       count(*) FILTER (WHERE status = 'success')::text AS successful,
                       count(*) FILTER (WHERE status = 'failed')::text AS failed,
                       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms)
                           FILTER (WHERE duration_ms IS NOT NULL))::text AS p50_duration_ms,
                       round(percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms)
                           FILTER (WHERE duration_ms IS NOT NULL))::text AS p95_duration_ms,
                       round(avg(extract(epoch FROM (started_at - requested_at)) * 1000)
                           FILTER (WHERE started_at IS NOT NULL))::text AS average_queue_delay_ms
                FROM executions, bounds WHERE requested_at >= starts_at AND requested_at < generated_at
                GROUP BY 1
             )
             SELECT b.bucket, bounds.starts_at, bounds.generated_at,
                    coalesce(a.requested, '0') AS requested,
                    coalesce(a.successful, '0') AS successful, coalesce(a.failed, '0') AS failed,
                    a.p50_duration_ms, a.p95_duration_ms, a.average_queue_delay_ms
             FROM buckets b CROSS JOIN bounds LEFT JOIN activity a USING (bucket) ORDER BY b.bucket`,
            [settings.hours, settings.bucketMs]
        );
        res.status(200).json({
            window, bucketMs: settings.bucketMs,
            startsAt: result.rows[0]?.starts_at.toISOString() ?? new Date(Date.now() - settings.hours * 60 * 60_000).toISOString(),
            generatedAt: result.rows[0]?.generated_at.toISOString() ?? new Date().toISOString(),
            buckets: result.rows.map(row => ({
                at: row.bucket.toISOString(), requested: Number(row.requested), successful: Number(row.successful),
                failed: Number(row.failed), p50DurationMs: nullableNumber(row.p50_duration_ms),
                p95DurationMs: nullableNumber(row.p95_duration_ms), averageQueueDelayMs: nullableNumber(row.average_queue_delay_ms)
            }))
        });
    }));

    router.get('/search', route(async (req, res) => {
        const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
        if (query.length < 2 || query.length > 100) throw new AppError('INVALID_SEARCH_QUERY', 'q must contain between 2 and 100 characters.', 400);
        const pattern = `%${query.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
        const [jobs, executions, incidents] = await Promise.all([
            pool.query<{ id: string; name: string; status: string }>(
                `SELECT id, definition->>'name' AS name, status FROM jobs
                 WHERE id ILIKE $1 ESCAPE '\\' OR definition->>'name' ILIKE $1 ESCAPE '\\'
                 ORDER BY updated_at DESC LIMIT 8`, [pattern]
            ),
            pool.query<{ id: string; job_id: string; status: string; requested_at: Date }>(
                `SELECT id, job_id, status, requested_at FROM executions
                 WHERE id::text ILIKE $1 ESCAPE '\\' OR job_id ILIKE $1 ESCAPE '\\'
                 ORDER BY requested_at DESC LIMIT 8`, [pattern]
            ),
            pool.query<{ id: string; job_id: string; reason: string; state: string; severity: string }>(
                `SELECT id, job_id, reason, state, severity FROM operational_attention_items
                 WHERE reason ILIKE $1 ESCAPE '\\' OR job_id ILIKE $1 ESCAPE '\\'
                 ORDER BY last_occurred_at DESC LIMIT 8`, [pattern]
            )
        ]);
        const actions = [
            { id: 'run-job', label: 'Run job', permission: 'operator' },
            { id: 'create-job', label: 'Create job', permission: 'admin' },
            { id: 'open-attention', label: 'Open Attention', permission: 'viewer' }
        ].filter(action => action.label.toLowerCase().includes(query.toLowerCase()) &&
            (action.permission === 'viewer' || req.auth!.role === 'admin' || (action.permission === 'operator' && req.auth!.role === 'operator')));
        res.status(200).json({ jobs: jobs.rows, executions: executions.rows.map(item => ({ ...item, requested_at: item.requested_at.toISOString() })), incidents: incidents.rows, actions });
    }));

    return router;
}

function statusMap(rows: StatusCountRow[]): Record<string, number> {
    return Object.fromEntries(rows.map(row => [row.status, Number(row.count)]));
}

function nullableNumber(value: string | null): number | null { return value === null ? null : Number(value); }

type Handler = (req: Request, res: Response) => Promise<void>;
function route(handler: Handler): (req: Request, res: Response, next: NextFunction) => void {
    return (req, res, next) => { void handler(req, res).catch(next); };
}
