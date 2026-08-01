import type { DatabaseClient, DatabasePool } from '../db/pool.js';
import { isUniqueViolation, withTransaction } from '../db/pool.js';
import { AppError } from '../errors.js';
import type {
    AuthenticatedActor,
    Job,
    JobRevision,
    JobRevisionSummary,
    JobStatus,
    JobVersionChangeType,
    JobView,
    PageResponse
} from '../types/index.js';
import { nextOccurrence } from '../utils/cron.js';

interface JobRow {
    definition: Job;
    current_version: number;
    last_run_at: Date | null;
    next_run_at: Date | null;
    created_at: Date;
    updated_at: Date;
}

interface RevisionRow {
    job_id: string;
    version: number;
    definition: Job;
    change_type: JobVersionChangeType;
    created_by_type: 'system' | 'user' | 'api_token';
    created_by_user_id: string | null;
    created_by_label: string;
    restored_from_version: number | null;
    created_at: Date;
}

export class JobRepository {
    constructor(readonly pool: DatabasePool) {}

    async getAll(): Promise<JobView[]> {
        const result = await this.pool.query<JobRow>(
            'SELECT definition, current_version, last_run_at, next_run_at, created_at, updated_at FROM jobs ORDER BY id'
        );
        return result.rows.map(mapJob);
    }

    async getById(jobId: string): Promise<JobView | undefined> {
        const result = await this.pool.query<JobRow>(
            'SELECT definition, current_version, last_run_at, next_run_at, created_at, updated_at FROM jobs WHERE id = $1',
            [jobId]
        );
        return result.rows[0] === undefined ? undefined : mapJob(result.rows[0]);
    }

    async create(job: Job, now?: Date, actor?: AuthenticatedActor): Promise<JobView> {
        try {
            return await withTransaction(this.pool, async client => {
                const effectiveNow = now ?? await databaseNow(client);
                const result = await client.query<JobRow>(
                    `INSERT INTO jobs(id, definition, status, schedule, timezone, next_run_at, current_version)
                     VALUES ($1, $2, $3, $4, $5, $6, 1)
                     RETURNING definition, current_version, last_run_at, next_run_at, created_at, updated_at`,
                    [job.id, job, job.status, job.schedule ?? null, job.timezone, scheduledNextRun(job, effectiveNow)]
                );
                await insertRevision(client, job.id, 1, job, actor === undefined ? 'import' : 'create', actor);
                return mapJob(result.rows[0]!);
            });
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
            'SELECT id FROM jobs WHERE id = ANY($1::text[]) ORDER BY id', [jobIds]
        );
        return result.rows.map(row => row.id);
    }

    async createMany(jobs: Job[], now?: Date): Promise<JobView[]> {
        if (jobs.length === 0) return [];
        try {
            return await withTransaction(this.pool, async client => {
                const effectiveNow = now ?? await databaseNow(client);
                const existing = await client.query<{ id: string }>(
                    'SELECT id FROM jobs WHERE id = ANY($1::text[]) FOR UPDATE', [jobs.map(job => job.id)]
                );
                if (existing.rows.length > 0) {
                    const ids = existing.rows.map(row => row.id).sort();
                    throw new AppError('JOB_ALREADY_EXISTS', `Import refused because these job IDs already exist: ${ids.join(', ')}.`, 409);
                }
                const created: JobView[] = [];
                for (const job of jobs) {
                    const result = await client.query<JobRow>(
                        `INSERT INTO jobs(id, definition, status, schedule, timezone, next_run_at, current_version)
                         VALUES ($1, $2, $3, $4, $5, $6, 1)
                         RETURNING definition, current_version, last_run_at, next_run_at, created_at, updated_at`,
                        [job.id, job, job.status, job.schedule ?? null, job.timezone, scheduledNextRun(job, effectiveNow)]
                    );
                    await insertRevision(client, job.id, 1, job, 'import');
                    created.push(mapJob(result.rows[0]!));
                }
                return created;
            });
        } catch (error: unknown) {
            if (isUniqueViolation(error, 'jobs_pkey')) {
                throw new AppError('JOB_ALREADY_EXISTS', 'Import refused because at least one job ID already exists.', 409);
            }
            throw error;
        }
    }

    async setStatuses(jobIds: string[], status: JobStatus, now?: Date, actor?: AuthenticatedActor): Promise<JobView[]> {
        if (jobIds.length === 0) return [];
        return withTransaction(this.pool, async client => {
            const effectiveNow = now ?? await databaseNow(client);
            const current = await client.query<{ id: string; definition: Job; current_version: number }>(
                `SELECT id, definition, current_version FROM jobs
                 WHERE id = ANY($1::text[]) ORDER BY id FOR UPDATE`, [jobIds]
            );
            if (current.rows.length !== jobIds.length) {
                const found = new Set(current.rows.map(row => row.id));
                throw new AppError('JOB_NOT_FOUND', `Jobs not found: ${jobIds.filter(id => !found.has(id)).join(', ')}.`, 404);
            }
            const rows = new Map(current.rows.map(row => [row.id, row]));
            const updated: JobView[] = [];
            for (const jobId of jobIds) {
                const row = rows.get(jobId)!;
                const definition = { ...row.definition, status };
                const version = row.current_version + 1;
                const result = await client.query<JobRow>(
                    `UPDATE jobs SET definition = $2, status = $3, current_version = $4, next_run_at = $5,
                        updated_at = clock_timestamp() WHERE id = $1
                     RETURNING definition, current_version, last_run_at, next_run_at, created_at, updated_at`,
                    [jobId, definition, status, version, scheduledNextRun(definition, effectiveNow)]
                );
                await insertRevision(client, jobId, version, definition, 'status', actor);
                updated.push(mapJob(result.rows[0]!));
            }
            return updated;
        });
    }

    async replace(jobId: string, replacement: Job, expectedVersion?: number, now?: Date, actor?: AuthenticatedActor): Promise<JobView> {
        return withTransaction(this.pool, async client => {
            const effectiveNow = now ?? await databaseNow(client);
            const current = await client.query<{ current_version: number }>(
                'SELECT current_version FROM jobs WHERE id = $1 FOR UPDATE', [jobId]
            );
            const row = current.rows[0];
            if (row === undefined) throw new AppError('JOB_NOT_FOUND', `Job with id ${jobId} not found.`, 404);
            assertExpectedVersion(jobId, expectedVersion, row.current_version);
            const version = row.current_version + 1;
            const result = await client.query<JobRow>(
                `UPDATE jobs SET definition = $2, status = $3, schedule = $4, timezone = $5,
                    next_run_at = $6, current_version = $7, updated_at = clock_timestamp()
                 WHERE id = $1
                 RETURNING definition, current_version, last_run_at, next_run_at, created_at, updated_at`,
                [jobId, replacement, replacement.status, replacement.schedule ?? null, replacement.timezone,
                    scheduledNextRun(replacement, effectiveNow), version]
            );
            await insertRevision(client, jobId, version, replacement, 'update', actor);
            return mapJob(result.rows[0]!);
        });
    }

    async rollback(jobId: string, targetVersion: number, expectedVersion: number, actor?: AuthenticatedActor): Promise<JobView> {
        return withTransaction(this.pool, async client => {
            const current = await client.query<{ definition: Job; current_version: number }>(
                'SELECT definition, current_version FROM jobs WHERE id = $1 FOR UPDATE', [jobId]
            );
            const row = current.rows[0];
            if (row === undefined) throw new AppError('JOB_NOT_FOUND', `Job with id ${jobId} not found.`, 404);
            assertExpectedVersion(jobId, expectedVersion, row.current_version);
            const target = await client.query<{ definition: Job }>(
                'SELECT definition FROM job_versions WHERE job_id = $1 AND version = $2', [jobId, targetVersion]
            );
            if (target.rows[0] === undefined) {
                throw new AppError('JOB_VERSION_NOT_FOUND', `Version ${targetVersion} of job ${jobId} was not found.`, 404);
            }
            const definition = { ...target.rows[0].definition, status: row.definition.status };
            const version = row.current_version + 1;
            const effectiveNow = await databaseNow(client);
            const result = await client.query<JobRow>(
                `UPDATE jobs SET definition = $2, status = $3, schedule = $4, timezone = $5,
                    next_run_at = $6, current_version = $7, updated_at = clock_timestamp()
                 WHERE id = $1
                 RETURNING definition, current_version, last_run_at, next_run_at, created_at, updated_at`,
                [jobId, definition, definition.status, definition.schedule ?? null, definition.timezone,
                    scheduledNextRun(definition, effectiveNow), version]
            );
            await insertRevision(client, jobId, version, definition, 'rollback', actor, targetVersion);
            return mapJob(result.rows[0]!);
        });
    }

    async listVersions(jobId: string, page: number, limit: number): Promise<PageResponse<JobRevisionSummary>> {
        const exists = await this.pool.query('SELECT 1 FROM jobs WHERE id = $1', [jobId]);
        if (exists.rowCount === 0) throw new AppError('JOB_NOT_FOUND', `Job with id ${jobId} not found.`, 404);
        const [items, count] = await Promise.all([
            this.pool.query<RevisionRow>(
                `SELECT * FROM job_versions WHERE job_id = $1 ORDER BY version DESC OFFSET $2 LIMIT $3`,
                [jobId, (page - 1) * limit, limit]
            ),
            this.pool.query<{ count: string }>('SELECT count(*)::text AS count FROM job_versions WHERE job_id = $1', [jobId])
        ]);
        const total = Number(count.rows[0]?.count ?? 0);
        return { items: items.rows.map(mapRevisionSummary), page, pageSize: limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) };
    }

    async getVersion(jobId: string, version: number): Promise<JobRevision> {
        const result = await this.pool.query<RevisionRow>(
            'SELECT * FROM job_versions WHERE job_id = $1 AND version = $2', [jobId, version]
        );
        const row = result.rows[0];
        if (row === undefined) throw new AppError('JOB_VERSION_NOT_FOUND', `Version ${version} of job ${jobId} was not found.`, 404);
        return { ...mapRevisionSummary(row), definition: row.definition };
    }

    async delete(jobId: string): Promise<void> {
        await withTransaction(this.pool, async client => {
            const current = await client.query('SELECT id FROM jobs WHERE id = $1 FOR UPDATE', [jobId]);
            if (current.rowCount === 0) throw new AppError('JOB_NOT_FOUND', `Job with id ${jobId} not found.`, 404);
            const active = await client.query(
                `SELECT 1 FROM executions WHERE job_id = $1 AND status IN ('queued', 'running') LIMIT 1`, [jobId]
            );
            if ((active.rowCount ?? 0) > 0) {
                throw new AppError('JOB_IS_ACTIVE', `Cannot delete job with id ${jobId} while an execution is queued or running.`, 409);
            }
            await client.query('DELETE FROM jobs WHERE id = $1', [jobId]);
        });
    }
}

async function insertRevision(client: DatabaseClient, jobId: string, version: number, definition: Job,
    changeType: JobVersionChangeType, actor?: AuthenticatedActor, restoredFromVersion?: number): Promise<void> {
    await client.query(
        `INSERT INTO job_versions(job_id, version, definition, change_type, created_by_type,
            created_by_user_id, created_by_label, restored_from_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [jobId, version, definition, changeType,
            actor === undefined ? 'system' : actor.authType === 'session' ? 'user' : 'api_token',
            actor?.userId ?? null, actor?.email ?? 'system', restoredFromVersion ?? null]
    );
}

function assertExpectedVersion(jobId: string, expected: number | undefined, current: number): void {
    if (expected === undefined) return;
    if (expected !== current) {
        throw new AppError('JOB_VERSION_CONFLICT', `Job ${jobId} is now at version ${current}.`, 409, { currentVersion: current });
    }
}

async function databaseNow(client: DatabaseClient): Promise<Date> {
    return (await client.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now;
}

function scheduledNextRun(job: Job, now: Date): Date | null {
    if (job.status !== 'active' || job.schedule === undefined) return null;
    return nextOccurrence(job.schedule, job.timezone, now);
}

function mapJob(row: JobRow): JobView {
    return { ...row.definition, version: row.current_version, last_run: row.last_run_at?.toISOString() ?? null,
        next_run: row.next_run_at?.toISOString() ?? null, created_at: row.created_at.toISOString(), updated_at: row.updated_at.toISOString() };
}

function mapRevisionSummary(row: RevisionRow): JobRevisionSummary {
    return { jobId: row.job_id, version: row.version, changeType: row.change_type,
        createdBy: { type: row.created_by_type, userId: row.created_by_user_id, label: row.created_by_label },
        restoredFromVersion: row.restored_from_version, createdAt: row.created_at.toISOString() };
}
