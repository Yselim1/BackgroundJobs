import express, { type NextFunction, type Request, type Response } from 'express';
import type { DatabasePool } from './db/pool.js';
import { assertSchemaCurrent } from './db/migrations.js';
import { AppError } from './errors.js';
import { createExecutionsController } from './controllers/executionsController.js';
import { createJobsController } from './controllers/jobsController.js';
import { createLogsController } from './controllers/logsController.js';
import { ExecutionRepository } from './repositories/ExecutionRepository.js';
import { JobExecutionManager } from './services/JobExecutionManager.js';
import { JobService } from './services/JobService.js';
import type { WebhookDispatcher } from './services/WebhookDispatcher.js';
import { JobValidationError } from './utils/jobValidator.js';

export interface AppDependencies {
    pool: DatabasePool;
    jobs: JobService;
    executions: ExecutionRepository;
    manager: JobExecutionManager;
    webhookDispatcher?: WebhookDispatcher;
}

export function createApp(dependencies: AppDependencies): express.Express {
    const app = express();
    app.use(express.json());
    app.get('/health', (_req, res) => { res.status(200).json({ status: 'ok' }); });
    app.get('/health/ready', async (_req, res) => {
        try {
            await dependencies.pool.query('SELECT 1');
            await assertSchemaCurrent(dependencies.pool);
            if (!dependencies.manager.started || !dependencies.webhookDispatcher?.started) {
                throw new Error('Scheduler, execution dispatcher, and webhook dispatcher have not started.');
            }
            res.status(200).json({ status: 'ready' });
        } catch (error: unknown) {
            res.status(503).json({ status: 'not_ready', error: error instanceof Error ? error.message : String(error) });
        }
    });
    app.use('/api/jobs', createJobsController(dependencies.jobs));
    app.use('/api/executions', createExecutionsController(dependencies.executions, dependencies.manager));
    app.use('/api/logs', createLogsController(dependencies.executions));
    app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
        if (error instanceof JobValidationError) {
            res.status(422).json({ error: 'Job definition validation failed.', code: 'JOB_VALIDATION_FAILED', details: error.issues });
            return;
        }
        if (error instanceof AppError) {
            res.status(error.statusCode).json({ error: error.message, code: error.code, ...(error.details === undefined ? {} : { details: error.details }) });
            return;
        }
        console.error('[HTTP] Unhandled error:', error);
        res.status(500).json({ error: 'Internal server error.', code: 'INTERNAL_ERROR' });
    });
    return app;
}
