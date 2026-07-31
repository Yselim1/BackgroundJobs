export interface AppConfig {
    databaseUrl: string;
    dbPoolMax: number;
    workerConcurrency: number;
    schedulerPollMs: number;
    shutdownGraceMs: number;
    webhookConcurrency: number;
    webhookPollMs: number;
    webhookMaxAttempts: number;
    webhookRequestTimeoutMs: number;
    webhookSigningKey: string | undefined;
    port: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
    return {
        databaseUrl: env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/backgroundjobs',
        dbPoolMax: positiveInteger(env.DB_POOL_MAX, 10, 'DB_POOL_MAX'),
        workerConcurrency: positiveInteger(env.WORKER_CONCURRENCY, 4, 'WORKER_CONCURRENCY'),
        schedulerPollMs: positiveInteger(env.SCHEDULER_POLL_MS, 1000, 'SCHEDULER_POLL_MS'),
        shutdownGraceMs: positiveInteger(env.SHUTDOWN_GRACE_MS, 10000, 'SHUTDOWN_GRACE_MS'),
        webhookConcurrency: positiveInteger(env.WEBHOOK_CONCURRENCY, 2, 'WEBHOOK_CONCURRENCY'),
        webhookPollMs: positiveInteger(env.WEBHOOK_POLL_MS, 500, 'WEBHOOK_POLL_MS'),
        webhookMaxAttempts: positiveInteger(env.WEBHOOK_MAX_ATTEMPTS, 5, 'WEBHOOK_MAX_ATTEMPTS'),
        webhookRequestTimeoutMs: positiveInteger(env.WEBHOOK_REQUEST_TIMEOUT_MS, 10000, 'WEBHOOK_REQUEST_TIMEOUT_MS'),
        webhookSigningKey: nonEmptyString(env.WEBHOOK_SIGNING_KEY, 'WEBHOOK_SIGNING_KEY'),
        port: positiveInteger(env.PORT, 3000, 'PORT')
    };
}

function nonEmptyString(value: string | undefined, name: string): string | undefined {
    if (value === undefined) return undefined;
    if (value.trim().length === 0) throw new Error(`${name} must be non-empty when provided.`);
    return value;
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
    if (value === undefined) return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`${name} must be a positive integer.`);
    }
    return parsed;
}
