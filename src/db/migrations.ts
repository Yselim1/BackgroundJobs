import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { DatabasePool } from './pool.js';

const MIGRATION_PATTERN = /^(\d{3,})_(.+)\.sql$/u;
const ADVISORY_LOCK_KEY = 'backgroundjobs-framework:migrations';

export interface Migration { version: number; name: string; sql: string; }

export async function readMigrations(directory = path.resolve(process.cwd(), 'migrations')): Promise<Migration[]> {
    const names = await fs.readdir(directory);
    const migrations = await Promise.all(names.flatMap(name => {
        const match = MIGRATION_PATTERN.exec(name);
        if (!match?.[1] || !match[2]) return [];
        return [fs.readFile(path.join(directory, name), 'utf8').then(sql => ({
            version: Number(match[1]),
            name: match[2]!,
            sql
        }))];
    }));
    migrations.sort((first, second) => first.version - second.version);
    for (let index = 1; index < migrations.length; index++) {
        if (migrations[index - 1]?.version === migrations[index]?.version) {
            throw new Error(`Duplicate migration version ${migrations[index]?.version}.`);
        }
    }
    return migrations;
}

export async function migrate(pool: DatabasePool): Promise<number> {
    const migrations = await readMigrations();
    const client = await pool.connect();
    try {
        await client.query('SELECT pg_advisory_lock(hashtext($1))', [ADVISORY_LOCK_KEY]);
        await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
            version integer PRIMARY KEY,
            name text NOT NULL,
            applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
        )`);
        const applied = await client.query<{ version: number }>('SELECT version FROM schema_migrations');
        const appliedVersions = new Set(applied.rows.map(row => row.version));
        for (const migration of migrations) {
            if (appliedVersions.has(migration.version)) continue;
            await client.query('BEGIN');
            try {
                await client.query(migration.sql);
                await client.query(
                    'INSERT INTO schema_migrations(version, name) VALUES ($1, $2)',
                    [migration.version, migration.name]
                );
                await client.query('COMMIT');
            } catch (error: unknown) {
                await client.query('ROLLBACK');
                throw error;
            }
        }
        return migrations.at(-1)?.version ?? 0;
    } finally {
        await client.query('SELECT pg_advisory_unlock(hashtext($1))', [ADVISORY_LOCK_KEY]).catch(() => undefined);
        client.release();
    }
}

export async function getSchemaVersions(pool: DatabasePool): Promise<{ current: number; latest: number }> {
    const migrations = await readMigrations();
    const latest = migrations.at(-1)?.version ?? 0;
    try {
        const result = await pool.query<{ version: number | null }>('SELECT max(version)::integer AS version FROM schema_migrations');
        return { current: result.rows[0]?.version ?? 0, latest };
    } catch (error: unknown) {
        if (error instanceof Error && 'code' in error && error.code === '42P01') return { current: 0, latest };
        throw error;
    }
}

export async function assertSchemaCurrent(pool: DatabasePool): Promise<void> {
    const versions = await getSchemaVersions(pool);
    if (versions.current !== versions.latest) {
        throw new Error(
            `Database schema is at version ${versions.current}, but version ${versions.latest} is required. ` +
            'Run "npm run migrate" before starting the application.'
        );
    }
}
