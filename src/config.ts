export interface AppConfig {
    databaseUrl: string;
    dbPoolMax: number;
    workerConcurrency: number;
    schedulerPollMs: number;
    shutdownGraceMs: number;
    port: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
    return {
        databaseUrl: env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/backgroundjobs',
        dbPoolMax: positiveInteger(env.DB_POOL_MAX, 10, 'DB_POOL_MAX'),
        workerConcurrency: positiveInteger(env.WORKER_CONCURRENCY, 4, 'WORKER_CONCURRENCY'),
        schedulerPollMs: positiveInteger(env.SCHEDULER_POLL_MS, 1000, 'SCHEDULER_POLL_MS'),
        shutdownGraceMs: positiveInteger(env.SHUTDOWN_GRACE_MS, 10000, 'SHUTDOWN_GRACE_MS'),
        port: positiveInteger(env.PORT, 3000, 'PORT')
    };
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
    if (value === undefined) return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`${name} must be a positive integer.`);
    }
    return parsed;
}

