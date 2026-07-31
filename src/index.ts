import { createServer } from 'node:http';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { assertSchemaCurrent } from './db/migrations.js';
import { createPool } from './db/pool.js';
import { ExecutionRepository } from './repositories/ExecutionRepository.js';
import { JobRepository } from './repositories/JobRepository.js';
import { WebhookRepository } from './repositories/WebhookRepository.js';
import { JobExecutionManager } from './services/JobExecutionManager.js';
import { JobService } from './services/JobService.js';
import { WebhookDispatcher } from './services/WebhookDispatcher.js';

const config = loadConfig();
const pool = createPool(config.databaseUrl, config.dbPoolMax);

try {
    await assertSchemaCurrent(pool);
    const jobRepository = new JobRepository(pool);
    const executionRepository = new ExecutionRepository(pool);
    const webhookRepository = new WebhookRepository(pool);
    const manager = new JobExecutionManager(
        executionRepository,
        undefined,
        config.workerConcurrency,
        config.schedulerPollMs
    );
    const webhookDispatcher = new WebhookDispatcher(webhookRepository, {
        concurrency: config.webhookConcurrency,
        pollMs: config.webhookPollMs,
        maxAttempts: config.webhookMaxAttempts,
        requestTimeoutMs: config.webhookRequestTimeoutMs,
        ...(config.webhookSigningKey === undefined ? {} : { signingKey: config.webhookSigningKey })
    });
    const jobs = new JobService(jobRepository, executionRepository);
    await manager.start();
    try {
        await webhookDispatcher.start();
    } catch (error: unknown) {
        await manager.shutdown(0);
        throw error;
    }
    const server = createServer(createApp({
        pool,
        jobs,
        executions: executionRepository,
        manager,
        webhookDispatcher
    }));
    server.listen(config.port, () => console.log(`Background Job Server is running on http://localhost:${config.port}`));

    let shuttingDown = false;
    const shutdown = async (): Promise<void> => {
        if (shuttingDown) return;
        shuttingDown = true;
        server.close();
        await Promise.all([
            manager.shutdown(config.shutdownGraceMs),
            webhookDispatcher.shutdown()
        ]);
        await pool.end();
    };
    process.once('SIGINT', () => void shutdown());
    process.once('SIGTERM', () => void shutdown());
} catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    await pool.end();
    process.exitCode = 1;
}
