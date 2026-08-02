import { createServer } from 'node:http';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { assertSchemaCurrent } from './db/migrations.js';
import { createPool } from './db/pool.js';
import { ExecutionRepository } from './repositories/ExecutionRepository.js';
import { AutomationRepository } from './repositories/AutomationRepository.js';
import { JobRepository } from './repositories/JobRepository.js';
import { WebhookRepository } from './repositories/WebhookRepository.js';
import { WorkerRepository } from './repositories/WorkerRepository.js';
import { JobExecutionManager } from './services/JobExecutionManager.js';
import { AutomationDispatcher } from './services/AutomationDispatcher.js';
import { JobService } from './services/JobService.js';
import { WebhookDispatcher } from './services/WebhookDispatcher.js';
import { createSecurityRuntime } from './security/runtime.js';
import { NotificationRepository } from './repositories/NotificationRepository.js';
import { NotificationDispatcher } from './services/NotificationDispatcher.js';

const config = loadConfig();
const pool = createPool(config.databaseUrl, config.dbPoolMax);

try {
    await assertSchemaCurrent(pool);
    const jobRepository = new JobRepository(pool);
    const executionRepository = new ExecutionRepository(pool);
    const automationRepository = new AutomationRepository(pool, executionRepository);
    const webhookRepository = new WebhookRepository(pool);
    const security = createSecurityRuntime(pool, config);
    const notificationRepository = new NotificationRepository(pool);
    const notificationDispatcher = new NotificationDispatcher(notificationRepository, security.secrets, {
        pollMs: config.webhookPollMs,
        maxAttempts: config.webhookMaxAttempts,
        requestTimeoutMs: config.webhookRequestTimeoutMs
    });
    const workerRepository = new WorkerRepository(pool, config.workerStaleMs);
    const manager = new JobExecutionManager(
        executionRepository,
        undefined,
        config.workerConcurrency,
        config.schedulerPollMs,
        security.secrets,
        { repository: workerRepository, ...(config.workerName === undefined ? {} : { name: config.workerName }), queues: config.workerQueues,
            heartbeatMs: config.workerHeartbeatMs, leaseMs: config.executionLeaseMs,
            workerEnabled: config.embeddedWorkerEnabled }
    );
    const webhookDispatcher = new WebhookDispatcher(webhookRepository, {
        concurrency: config.webhookConcurrency,
        pollMs: config.webhookPollMs,
        maxAttempts: config.webhookMaxAttempts,
        requestTimeoutMs: config.webhookRequestTimeoutMs,
        secrets: security.secrets,
        ...(config.webhookSigningKey === undefined ? {} : { signingKey: config.webhookSigningKey })
    });
    const automationDispatcher = new AutomationDispatcher(automationRepository);
    const jobs = new JobService(jobRepository, executionRepository);
    await manager.start();
    try {
        await webhookDispatcher.start();
        await automationDispatcher.start();
        await notificationDispatcher.start();
    } catch (error: unknown) {
        await manager.shutdown(0);
        await Promise.all([webhookDispatcher.shutdown(), automationDispatcher.shutdown(), notificationDispatcher.shutdown()]);
        throw error;
    }
    const server = createServer(createApp({
        pool,
        jobs,
        executions: executionRepository,
        manager,
        webhookDispatcher,
        automations: automationRepository,
        automationDispatcher,
        notifications: notificationRepository,
        notificationDispatcher,
        security
    }));
    server.listen(config.port, () => console.log(`Background Job Server is running on http://localhost:${config.port}`));

    let shuttingDown = false;
    const shutdown = async (): Promise<void> => {
        if (shuttingDown) return;
        shuttingDown = true;
        server.close();
        await Promise.all([
            manager.shutdown(config.shutdownGraceMs),
            webhookDispatcher.shutdown(),
            automationDispatcher.shutdown(),
            notificationDispatcher.shutdown()
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
