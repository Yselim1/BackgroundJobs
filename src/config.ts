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
    authSessionTtlMs: number;
    authSessionIdleMs: number;
    authCookieSecure: boolean;
    corsAllowedOrigins: string[];
    trustProxy: boolean;
    secretsMasterKey: string | undefined;
    port: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
    const config: AppConfig = {
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
        authSessionTtlMs: positiveInteger(env.AUTH_SESSION_TTL_MS, 43_200_000, 'AUTH_SESSION_TTL_MS'),
        authSessionIdleMs: positiveInteger(env.AUTH_SESSION_IDLE_MS, 1_800_000, 'AUTH_SESSION_IDLE_MS'),
        authCookieSecure: booleanValue(env.AUTH_COOKIE_SECURE, env.NODE_ENV === 'production', 'AUTH_COOKIE_SECURE'),
        corsAllowedOrigins: commaSeparated(env.CORS_ALLOWED_ORIGINS, ['http://localhost:3000', 'http://localhost:5173']),
        trustProxy: booleanValue(env.TRUST_PROXY, false, 'TRUST_PROXY'),
        secretsMasterKey: validateMasterKey(nonEmptyString(env.SECRETS_MASTER_KEY, 'SECRETS_MASTER_KEY')),
        port: positiveInteger(env.PORT, 3000, 'PORT')
    };
    if (config.authSessionIdleMs > config.authSessionTtlMs) {
        throw new Error('AUTH_SESSION_IDLE_MS cannot exceed AUTH_SESSION_TTL_MS.');
    }
    if (env.NODE_ENV === 'production') {
        if (!config.authCookieSecure) {
            throw new Error('AUTH_COOKIE_SECURE must be true in production.');
        }
        if (env.CORS_ALLOWED_ORIGINS === undefined) {
            throw new Error('CORS_ALLOWED_ORIGINS must be configured explicitly in production.');
        }
    }
    return config;
}

function commaSeparated(value: string | undefined, fallback: string[]): string[] {
    if (value === undefined) return fallback;
    const values = value.split(',').map(item => item.trim()).filter(item => item.length > 0);
    if (values.length === 0) throw new Error('CORS_ALLOWED_ORIGINS must contain at least one origin.');
    for (const origin of values) {
        const url = new URL(origin);
        if (url.origin !== origin || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
            throw new Error('CORS_ALLOWED_ORIGINS contains an invalid origin: ' + origin + '.');
        }
    }
    return [...new Set(values)];
}

function booleanValue(value: string | undefined, fallback: boolean, name: string): boolean {
    if (value === undefined) return fallback;
    if (value === 'true') return true;
    if (value === 'false') return false;
    throw new Error(name + ' must be true or false.');
}

function validateMasterKey(value: string | undefined): string | undefined {
    if (value === undefined) return undefined;
    const decoded = Buffer.from(value, 'base64');
    if (decoded.length !== 32 || decoded.toString('base64') !== value) {
        throw new Error('SECRETS_MASTER_KEY must be a canonical base64-encoded 32-byte key.');
    }
    return value;
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
