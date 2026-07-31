import type { DatabasePool } from '../db/pool.js';
import { isUniqueViolation, withTransaction } from '../db/pool.js';
import { AppError } from '../errors.js';
import type { Job, JobView } from '../types/index.js';
import { nextOccurrence } from '../utils/cron.js';

interface JobRow {
    definition: Job;
    last_run_at: Date | null;
    next_run_at: Date | null;
    created_at: Date;
    updated_at: Date;
}

export class JobRepository {
    constructor(readonly pool: DatabasePool) {}

    async getAll(): Promise<JobView[]> {
        const result = await this.pool.query<JobRow>(
            'SELECT definition, last_run_at, next_run_at, created_at, updated_at FROM jobs ORDER BY id'
        );
        return result.rows.map(mapJob);
    }

    async getById(jobId: string): Promise<JobView | undefined> {
        const result = await this.pool.query<JobRow>(
            'SELECT definition, last_run_at, next_run_at, created_at, updated_at FROM jobs WHERE id = $1',
            [jobId]
        );
        return result.rows[0] === undefined ? undefined : mapJob(result.rows[0]);
    }

    async create(job: Job, now = new Date()): Promise<JobView> {
        const nextRunAt = scheduledNextRun(job, now);
        try {
            const result = await this.pool.query<JobRow>(
                `INSERT INTO jobs(id, definition, status, schedule, timezone, next_run_at)
                 VALUES ($1, $2, $3, $4, $5, $6)
                 RETURNING definition, last_run_at, next_run_at, created_at, updated_at`,
                [job.id, job, job.status, job.schedule ?? null, job.timezone, nextRunAt]
            );
            return mapJob(result.rows[0]!);
        } catch (error: unknown) {
            if (isUniqueViolation(error, 'jobs_pkey')) {
                throw new AppError('JOB_ALREADY_EXISTS', `Job with id ${job.id} already exists.`, 409);
            }
            throw error;
        }
    }

    async replace(jobId: string, replacement: Job, now = new Date()): Promise<JobView> {
        return withTransaction(this.pool, async client => {
            const current = await client.query('SELECT id FROM jobs WHERE id = $1 FOR UPDATE', [jobId]);
            if (current.rowCount === 0) throw new AppError('JOB_NOT_FOUND', `Job with id ${jobId} not found.`, 404);
            const active = await client.query(
                `SELECT 1 FROM executions WHERE job_id = $1 AND status IN ('queued', 'running') LIMIT 1`,
                [jobId]
            );
            if ((active.rowCount ?? 0) > 0) {
                throw new AppError('JOB_IS_ACTIVE', `Cannot update job with id ${jobId} while an execution is queued or running.`, 409);
            }
            const result = await client.query<JobRow>(
                `UPDATE jobs SET definition = $2, status = $3, schedule = $4, timezone = $5,
                    next_run_at = $6, updated_at = clock_timestamp()
                 WHERE id = $1
                 RETURNING definition, last_run_at, next_run_at, created_at, updated_at`,
                [jobId, replacement, replacement.status, replacement.schedule ?? null, replacement.timezone, scheduledNextRun(replacement, now)]
            );
            return mapJob(result.rows[0]!);
        });
    }

    async delete(jobId: string): Promise<void> {
        await withTransaction(this.pool, async client => {
            const current = await client.query('SELECT id FROM jobs WHERE id = $1 FOR UPDATE', [jobId]);
            if (current.rowCount === 0) throw new AppError('JOB_NOT_FOUND', `Job with id ${jobId} not found.`, 404);
            const active = await client.query(
                `SELECT 1 FROM executions WHERE job_id = $1 AND status IN ('queued', 'running') LIMIT 1`,
                [jobId]
            );
            if ((active.rowCount ?? 0) > 0) {
                throw new AppError('JOB_IS_ACTIVE', `Cannot delete job with id ${jobId} while an execution is queued or running.`, 409);
            }
            await client.query('DELETE FROM jobs WHERE id = $1', [jobId]);
        });
    }
}

function scheduledNextRun(job: Job, now: Date): Date | null {
    if (job.status !== 'active' || job.schedule === undefined) return null;
    return nextOccurrence(job.schedule, job.timezone, now);
}

function mapJob(row: JobRow): JobView {
    return {
        ...row.definition,
        last_run: row.last_run_at?.toISOString() ?? null,
        next_run: row.next_run_at?.toISOString() ?? null,
        created_at: row.created_at.toISOString(),
        updated_at: row.updated_at.toISOString()
    };
}
