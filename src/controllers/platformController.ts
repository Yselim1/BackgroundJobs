import { Router, type NextFunction, type Request, type Response } from 'express';
import type { DatabasePool } from '../db/pool.js';
import { ExecutorRegistry } from '../executors/ExecutorRegistry.js';
import { AttentionRepository } from '../repositories/AttentionRepository.js';

interface CountRow { count: string; }
interface StatusCountRow { status: string; count: string; }
export function createPlatformController(pool: DatabasePool, workerConcurrency = 4): Router {
    const router = Router();
    const attention = new AttentionRepository(pool);

    router.get('/overview', route(async (_req, res) => {
        const [clock, jobs, executions, webhooks, duration, operations, durableAttention] = await Promise.all([
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
            attention.openOverview()
        ]);
        const jobCounts = statusMap(jobs.rows);
        const executionCounts = statusMap(executions.rows);
        const webhookCounts = statusMap(webhooks.rows);
        const running = executionCounts.running ?? 0;
        const successCount = Number(operations.rows[0]?.success_count ?? 0);
        const failedCount = Number(operations.rows[0]?.failed_count ?? 0);
        const terminalCount = successCount + failedCount;
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
                capacity: workerConcurrency,
                busy: running,
                available: Math.max(0, workerConcurrency - running),
                utilizationPercent: Math.round(Math.min(1, running / workerConcurrency) * 1000) / 10
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

    return router;
}

function statusMap(rows: StatusCountRow[]): Record<string, number> {
    return Object.fromEntries(rows.map(row => [row.status, Number(row.count)]));
}

type Handler = (req: Request, res: Response) => Promise<void>;
function route(handler: Handler): (req: Request, res: Response, next: NextFunction) => void {
    return (req, res, next) => { void handler(req, res).catch(next); };
}
