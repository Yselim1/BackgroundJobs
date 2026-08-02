import type { Step } from '../types/index.js';
import type { ExecutorOptions, IStepExecutor } from './IStepExecutor.js';
import { buildChildEnvironment, runProcess } from './processRunner.js';
import { resolveContextTemplates } from '../utils/contextResolver.js';
import { assertLiteral, resolveSafeEnvironment } from './executorSafety.js';

export class CommandExecutor implements IStepExecutor {
    async execute(step: Step, context: Record<string, unknown>, options: ExecutorOptions): Promise<unknown> {
        const params = step.STEP_PARAMS ?? {};
        const command = params.COMMAND;
        const executable = params.EXECUTABLE;
        const timeoutMs = params.TIMEOUT_MS ?? 30000;
        const cwd = params.CWD;
        if ((command === undefined) === (executable === undefined)) {
            throw new Error('COMMAND requires exactly one of COMMAND or EXECUTABLE.');
        }
        if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error('COMMAND TIMEOUT_MS must be a positive integer.');
        if (cwd !== undefined && typeof cwd !== 'string') throw new Error('COMMAND CWD must be a string.');
        if (cwd !== undefined) assertLiteral(cwd, 'COMMAND CWD');
        const env = resolveSafeEnvironment(params.ENV, context, 'COMMAND ENV');
        try {
            const base = {
                timeoutMs,
                signal: options.signal,
                ...(cwd === undefined ? {} : { cwd }),
                env: buildChildEnvironment(env)
            };
            const result = command !== undefined
                ? await runLegacyCommand(command, base)
                : await runSafeCommand(executable, params.ARGS, step, context, base);
            return result;
        } catch (error: unknown) {
            if (options.signal.aborted) throw options.signal.reason;
            throw new Error(`COMMAND execution failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}

type ProcessBase = Pick<Parameters<typeof runProcess>[0], 'timeoutMs' | 'signal' | 'cwd' | 'env'>;

async function runLegacyCommand(command: unknown, base: ProcessBase) {
    if (typeof command !== 'string' || command.length === 0) {
        throw new Error('COMMAND execution failed: COMMAND must be a non-empty string.');
    }
    assertLiteral(command, 'COMMAND');
    return runProcess({ ...base, command, shell: true });
}

async function runSafeCommand(
    executable: unknown,
    rawArgs: unknown,
    step: Step,
    context: Record<string, unknown>,
    base: ProcessBase
) {
    if (typeof executable !== 'string' || executable.length === 0) {
        throw new Error('COMMAND execution failed: EXECUTABLE must be a non-empty string.');
    }
    assertLiteral(executable, 'COMMAND EXECUTABLE');
    if (rawArgs !== undefined && !Array.isArray(rawArgs)) throw new Error('COMMAND ARGS must be an array.');
    const resolved = resolveContextTemplates(rawArgs ?? [], context, {
        allowedStepIds: new Set(step.DEPENDS_ON ?? [])
    });
    const args = resolved.map((value, index) => {
        if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
            return String(value);
        }
        throw new Error(`COMMAND ARGS[${index}] must resolve to a scalar value.`);
    });
    return runProcess({ ...base, command: executable, args, shell: false });
}
