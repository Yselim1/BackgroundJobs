import { describe, expect, it } from 'vitest';
import { ExecutionAbortError } from '../../src/errors.js';
import { runProcess } from '../../src/executors/processRunner.js';

describe('spawned process cancellation', () => {
    it('terminates an active child when its execution signal is aborted', async () => {
        const controller = new AbortController();
        const started = Date.now();
        const running = runProcess({
            command: process.execPath,
            args: ['-e', 'setInterval(() => {}, 1000)'],
            timeoutMs: 10000,
            signal: controller.signal
        });
        setTimeout(() => controller.abort(new ExecutionAbortError('EXECUTION_CANCELLED', 'test cancellation')), 100);
        await expect(running).rejects.toMatchObject({ code: 'EXECUTION_CANCELLED' });
        expect(Date.now() - started).toBeLessThan(3000);
    });
});
