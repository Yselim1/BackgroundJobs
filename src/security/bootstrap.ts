import { randomUUID } from 'node:crypto';
import { loadConfig } from '../config.js';
import { assertSchemaCurrent } from '../db/migrations.js';
import { createPool } from '../db/pool.js';
import { createSecurityRuntime } from './runtime.js';

const config = loadConfig();
const pool = createPool(config.databaseUrl, config.dbPoolMax);

try {
    await assertSchemaCurrent(pool);
    const email = process.env.BOOTSTRAP_ADMIN_EMAIL;
    const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
    const displayName = process.env.BOOTSTRAP_ADMIN_NAME ?? 'Administrator';
    if (email === undefined || password === undefined) {
        throw new Error(
            'Set BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD before running npm run auth:bootstrap.'
        );
    }
    const security = createSecurityRuntime(pool, config);
    const user = await security.auth.bootstrapAdmin(email, displayName, password);
    await security.audit.record({
        requestId: randomUUID(),
        actorType: 'system',
        actorLabel: 'bootstrap-cli',
        action: 'user.bootstrap',
        outcome: 'success',
        statusCode: 201,
        resourceType: 'user',
        resourceId: user.userId
    });
    console.log('Created initial administrator ' + user.email + '.');
} catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
} finally {
    await pool.end();
}
