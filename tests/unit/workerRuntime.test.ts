import { describe, expect, it, vi } from 'vitest';
import { JobExecutionManager } from '../../src/services/JobExecutionManager.js';
import type { ExecutionRepository } from '../../src/repositories/ExecutionRepository.js';
import type { WorkerRepository } from '../../src/repositories/WorkerRepository.js';

describe('isolated worker topology', () => {
    it('keeps the API manager scheduler-only when its embedded worker is disabled', async () => {
        const executions = {
            pool: {},
            reconcileExpiredLeases: vi.fn().mockResolvedValue(undefined)
        } as unknown as ExecutionRepository;
        const workers = {
            register: vi.fn(),
            stop: vi.fn()
        } as unknown as WorkerRepository;
        const manager = new JobExecutionManager(executions, undefined, 4, 1000, undefined, {
            repository: workers,
            schedulerEnabled: false,
            workerEnabled: false
        });

        await manager.start();
        expect(manager.started).toBe(true);
        expect(manager.capacity).toBe(0);
        expect(workers.register).not.toHaveBeenCalled();

        await manager.shutdown(0);
        expect(manager.started).toBe(false);
        expect(workers.stop).not.toHaveBeenCalled();
    });
});
