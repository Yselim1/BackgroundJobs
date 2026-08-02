import { loadConfig } from './config.js';
import { assertSchemaCurrent } from './db/migrations.js';
import { createPool } from './db/pool.js';
import { ExecutionRepository } from './repositories/ExecutionRepository.js';
import { WorkerRepository } from './repositories/WorkerRepository.js';
import { createSecurityRuntime } from './security/runtime.js';
import { JobExecutionManager } from './services/JobExecutionManager.js';
import { prepareWorkerRuntime } from './security/workerRuntime.js';

const config = loadConfig();
await prepareWorkerRuntime(config);
const pool = createPool(config.databaseUrl, config.dbPoolMax);

try {
    await assertSchemaCurrent(pool);
    const executions = new ExecutionRepository(pool);
    const workers = new WorkerRepository(pool, config.workerStaleMs);
    const security = createSecurityRuntime(pool, config);
    const manager = new JobExecutionManager(executions, undefined, config.workerConcurrency,
        config.schedulerPollMs, security.secrets, {
            repository: workers, ...(config.workerName === undefined ? {} : { name: config.workerName }), queues: config.workerQueues,
            heartbeatMs: config.workerHeartbeatMs, leaseMs: config.executionLeaseMs, schedulerEnabled: false
        });
    await manager.start();
    console.log(`Worker ${config.workerName ?? process.pid} is listening on queues: ${config.workerQueues.join(', ')}`);
    let stopping = false;
    const shutdown = async (): Promise<void> => {
        if (stopping) return;
        stopping = true;
        await manager.shutdown(config.shutdownGraceMs);
        await pool.end();
    };
    process.once('SIGINT', () => void shutdown());
    process.once('SIGTERM', () => void shutdown());
} catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    await pool.end();
    process.exitCode = 1;
}
