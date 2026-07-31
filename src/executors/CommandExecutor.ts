import type { Step } from '../types/index.js';
import type { ExecutorOptions, IStepExecutor } from './IStepExecutor.js';
import { runProcess } from './processRunner.js';
import { resolveContextTemplates } from '../utils/contextResolver.js';

export class CommandExecutor implements IStepExecutor {
    async execute(step: Step, context: Record<string, unknown>, options: ExecutorOptions): Promise<unknown> {
        const params = resolveContextTemplates(step.STEP_PARAMS ?? {}, context, {
            allowedStepIds: new Set(step.DEPENDS_ON ?? [])
        });
        const command = params.COMMAND;
        const timeoutMs = params.TIMEOUT_MS ?? 30000;
        const cwd = params.CWD;
        const env = params.ENV;
        if (typeof command !== 'string' || command.length === 0) throw new Error('COMMAND execution failed: COMMAND param is missing.');
        if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error('COMMAND TIMEOUT_MS must be a positive integer.');
        if (cwd !== undefined && typeof cwd !== 'string') throw new Error('COMMAND CWD must be a string.');
        if (env !== undefined && !isStringRecord(env)) throw new Error('COMMAND ENV must contain only string values.');
        try {
            const result = await runProcess({
                command,
                shell: true,
                timeoutMs,
                signal: options.signal,
                ...(cwd === undefined ? {} : { cwd }),
                env: { ...process.env, ...(env ?? {}) }
            });
            return result;
        } catch (error: unknown) {
            if (options.signal.aborted) throw options.signal.reason;
            throw new Error(`COMMAND execution failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}

function isStringRecord(value: unknown): value is Record<string, string> {
    return value !== null && typeof value === 'object' && !Array.isArray(value) &&
        Object.values(value).every(item => typeof item === 'string');
}
