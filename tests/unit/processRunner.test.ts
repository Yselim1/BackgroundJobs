import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

    it('rejects a pre-aborted execution without spawning', async () => {
        const controller = new AbortController();
        controller.abort(new ExecutionAbortError('EXECUTION_CANCELLED', 'already cancelled'));
        await expect(runProcess({
            command: process.execPath,
            args: ['-e', 'process.exit(0)'],
            timeoutMs: 1000,
            signal: controller.signal
        })).rejects.toMatchObject({ code: 'EXECUTION_CANCELLED' });
    });

    it('rejects promptly when the process timeout expires', async () => {
        const started = Date.now();
        await expect(runProcess({
            command: process.execPath,
            args: ['-e', 'setInterval(() => {}, 1000)'],
            timeoutMs: 100,
            signal: new AbortController().signal
        })).rejects.toThrow(/timed out/u);
        expect(Date.now() - started).toBeLessThan(3000);
    });

    const descendantTest = process.platform === 'win32' ? it.skip : it;
    descendantTest('terminates descendants when an execution is aborted', async () => {
        const marker = path.join(os.tmpdir(), `backgroundjobs-child-${randomUUID()}.txt`);
        const ready = path.join(os.tmpdir(), `backgroundjobs-parent-${randomUUID()}.txt`);
        const grandchild = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'alive'), 1000)`;
        const parent = `const { spawn } = require('node:child_process'); spawn(${JSON.stringify(process.execPath)}, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore' }); require('node:fs').writeFileSync(${JSON.stringify(ready)}, 'ready'); setInterval(() => {}, 1000);`;
        const controller = new AbortController();
        const running = runProcess({
            command: process.execPath,
            args: ['-e', parent],
            timeoutMs: 5000,
            signal: controller.signal
        });
        for (let attempt = 0; attempt < 50 && !(await exists(ready)); attempt++) {
            await new Promise(resolve => setTimeout(resolve, 20));
        }
        expect(await exists(ready)).toBe(true);
        controller.abort(new ExecutionAbortError('EXECUTION_CANCELLED', 'cancel tree'));
        await expect(running).rejects.toMatchObject({ code: 'EXECUTION_CANCELLED' });
        await new Promise(resolve => setTimeout(resolve, 1500));
        expect(await exists(marker)).toBe(false);
        await fs.unlink(marker).catch(() => undefined);
        await fs.unlink(ready).catch(() => undefined);
    });
});

async function exists(filePath: string): Promise<boolean> {
    return fs.stat(filePath).then(() => true).catch(() => false);
}
