import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Step } from '../types/index.js';
import type { ExecutorOptions, IStepExecutor } from './IStepExecutor.js';
import { runProcess } from './processRunner.js';
import { resolveContextTemplates } from '../utils/contextResolver.js';

export class PythonExecutor implements IStepExecutor {
    async execute(step: Step, context: Record<string, unknown>, options: ExecutorOptions): Promise<unknown> {
        const code = step.STEP_PARAMS?.CODE;
        const timeoutMs = step.STEP_PARAMS?.TIMEOUT_MS ?? 5000;
        const env = resolveContextTemplates(step.STEP_PARAMS?.ENV ?? {}, context, {
            allowedStepIds: new Set(step.DEPENDS_ON ?? [])
        });
        if (typeof code !== 'string' || code.length === 0) throw new Error('Python execution failed: CODE param is missing.');
        if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error('PYTHON TIMEOUT_MS must be a positive integer.');
        if (!isStringRecord(env)) throw new Error('PYTHON ENV must contain only string values.');
        const filePath = path.join(os.tmpdir(), `backgroundjob_${randomUUID()}.py`);
        try {
            await fs.writeFile(filePath, code, 'utf8');
            const result = await runProcess({
                command: 'python',
                args: [filePath],
                timeoutMs,
                signal: options.signal,
                env: { ...process.env, ...env }
            });
            try { return JSON.parse(result.stdout) as unknown; }
            catch { return { raw_output: result.stdout, stderr: result.stderr }; }
        } catch (error: unknown) {
            if (options.signal.aborted) throw options.signal.reason;
            throw new Error(`Python execution failed: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            await fs.unlink(filePath).catch(() => undefined);
        }
    }
}

function isStringRecord(value: unknown): value is Record<string, string> {
    return value !== null && typeof value === 'object' && !Array.isArray(value) &&
        Object.values(value).every(item => typeof item === 'string');
}
