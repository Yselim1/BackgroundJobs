import type { Step } from '../types/index.js';

export interface ExecutorOptions { signal: AbortSignal; }
export interface IStepExecutor {
    execute(step: Step, context: Record<string, unknown>, options: ExecutorOptions): Promise<unknown>;
}
