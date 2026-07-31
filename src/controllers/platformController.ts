import { Router, type NextFunction, type Request, type Response } from 'express';
import type { DatabasePool } from '../db/pool.js';
import { ExecutorRegistry } from '../executors/ExecutorRegistry.js';

interface CountRow { count: string; }
interface StatusCountRow { status: string; count: string; }

export function createPlatformController(pool: DatabasePool): Router {
    const router = Router();

    router.get('/overview', route(async (_req, res) => {
        const [clock, jobs, executions, webhooks, duration] = await Promise.all([
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
            )
        ]);
        const jobCounts = statusMap(jobs.rows);
        const executionCounts = statusMap(executions.rows);
        const webhookCounts = statusMap(webhooks.rows);
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
                averageSuccessDurationMs24h: duration.rows[0]?.average_ms === null
                    ? null
                    : Number(duration.rows[0]?.average_ms ?? 0)
            },
            webhooks: {
                pending: webhookCounts.pending ?? 0,
                delivering: webhookCounts.delivering ?? 0,
                failed: webhookCounts.failed ?? 0
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
