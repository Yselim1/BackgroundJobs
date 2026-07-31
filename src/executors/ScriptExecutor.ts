import vm from 'node:vm';
import { throwIfAborted } from '../errors.js';
import type { Step } from '../types/index.js';
import type { ExecutorOptions, IStepExecutor } from './IStepExecutor.js';

export class ScriptExecutor implements IStepExecutor {
    async execute(step: Step, context: Record<string, unknown>, options: ExecutorOptions): Promise<unknown> {
        const code = step.STEP_PARAMS?.CODE;
        if (typeof code !== 'string' || code.length === 0) throw new Error('Script execution failed: CODE param is missing.');
        const timeoutMs = step.STEP_PARAMS?.TIMEOUT_MS ?? 2000;
        if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs <= 0) {
            throw new Error('SCRIPT TIMEOUT_MS must be a positive integer.');
        }
        throwIfAborted(options.signal);
        const sandbox: { context: Record<string, unknown>; result: unknown } = { context, result: null };
        vm.createContext(sandbox);
        try {
            const script = new vm.Script(`const userFunction = ${code}; result = userFunction(context);`);
            script.runInContext(sandbox, { timeout: timeoutMs });
            throwIfAborted(options.signal);
            return sandbox.result;
        } catch (error: unknown) {
            if (options.signal.aborted) throw options.signal.reason;
            throw new Error(`Script Sandbox Error: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}
