import type { DatabasePool } from '../db/pool.js';
import { isUniqueViolation, withTransaction } from '../db/pool.js';
import { AppError } from '../errors.js';
import type { Job, JobStatus, JobView } from '../types/index.js';
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

    async create(job: Job, now?: Date): Promise<JobView> {
        const effectiveNow = now ?? (await this.pool.query<{ now: Date }>(
            'SELECT clock_timestamp() AS now'
        )).rows[0]!.now;
        const nextRunAt = scheduledNextRun(job, effectiveNow);
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

    async findExistingIds(jobIds: string[]): Promise<string[]> {
        if (jobIds.length === 0) return [];
        const result = await this.pool.query<{ id: string }>(
            'SELECT id FROM jobs WHERE id = ANY($1::text[]) ORDER BY id',
            [jobIds]
        );
        return result.rows.map(row => row.id);
    }

    async createMany(jobs: Job[], now?: Date): Promise<JobView[]> {
        if (jobs.length === 0) return [];
        try {
            return await withTransaction(this.pool, async client => {
                const effectiveNow = now ?? (await client.query<{ now: Date }>(
                    'SELECT clock_timestamp() AS now'
                )).rows[0]!.now;
                const existing = await client.query<{ id: string }>(
                    'SELECT id FROM jobs WHERE id = ANY($1::text[]) FOR UPDATE',
                    [jobs.map(job => job.id)]
                );
                if (existing.rows.length > 0) {
                    const ids = existing.rows.map(row => row.id).sort();
                    throw new AppError(
                        'JOB_ALREADY_EXISTS',
                        `Import refused because these job IDs already exist: ${ids.join(', ')}.`,
                        409
                    );
                }

                const created: JobView[] = [];
                for (const job of jobs) {
                    const result = await client.query<JobRow>(
                        `INSERT INTO jobs(id, definition, status, schedule, timezone, next_run_at)
                         VALUES ($1, $2, $3, $4, $5, $6)
                         RETURNING definition, last_run_at, next_run_at, created_at, updated_at`,
                        [
                            job.id,
                            job,
                            job.status,
                            job.schedule ?? null,
                            job.timezone,
                            scheduledNextRun(job, effectiveNow)
                        ]
                    );
                    created.push(mapJob(result.rows[0]!));
                }
                return created;
            });
        } catch (error: unknown) {
            if (isUniqueViolation(error, 'jobs_pkey')) {
                throw new AppError(
                    'JOB_ALREADY_EXISTS',
                    'Import refused because at least one job ID already exists.',
                    409
                );
            }
            throw error;
        }
    }

    async setStatuses(jobIds: string[], status: JobStatus, now?: Date): Promise<JobView[]> {
        if (jobIds.length === 0) return [];
        return withTransaction(this.pool, async client => {
            const effectiveNow = now ?? (await client.query<{ now: Date }>(
                'SELECT clock_timestamp() AS now'
            )).rows[0]!.now;
            const current = await client.query<{ id: string; definition: Job }>(
                `SELECT id, definition FROM jobs
                 WHERE id = ANY($1::text[])
                 ORDER BY id
                 FOR UPDATE`,
                [jobIds]
            );
            if (current.rows.length !== jobIds.length) {
                const found = new Set(current.rows.map(row => row.id));
                const missing = jobIds.filter(id => !found.has(id));
                throw new AppError('JOB_NOT_FOUND', `Jobs not found: ${missing.join(', ')}.`, 404);
            }
            const active = await client.query<{ job_id: string }>(
                `SELECT DISTINCT job_id FROM executions
                 WHERE job_id = ANY($1::text[]) AND status IN ('queued', 'running')
                 ORDER BY job_id`,
                [jobIds]
            );
            if (active.rows.length > 0) {
                throw new AppError(
                    'JOB_IS_ACTIVE',
                    `Cannot update jobs with queued or running executions: ${active.rows.map(row => row.job_id).join(', ')}.`,
                    409
                );
            }

            const updated: JobView[] = [];
            const definitions = new Map(current.rows.map(row => [row.id, row.definition]));
            for (const jobId of jobIds) {
                const definition = { ...definitions.get(jobId)!, status };
                const result = await client.query<JobRow>(
                    `UPDATE jobs SET definition = $2, status = $3, next_run_at = $4,
                        updated_at = clock_timestamp()
                     WHERE id = $1
                     RETURNING definition, last_run_at, next_run_at, created_at, updated_at`,
                    [jobId, definition, status, scheduledNextRun(definition, effectiveNow)]
                );
                updated.push(mapJob(result.rows[0]!));
            }
            return updated;
        });
    }

    async replace(jobId: string, replacement: Job, now?: Date): Promise<JobView> {
        return withTransaction(this.pool, async client => {
            const effectiveNow = now ?? (await client.query<{ now: Date }>(
                'SELECT clock_timestamp() AS now'
            )).rows[0]!.now;
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
                [jobId, replacement, replacement.status, replacement.schedule ?? null, replacement.timezone, scheduledNextRun(replacement, effectiveNow)]
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
