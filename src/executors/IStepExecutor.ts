import type { JsonSchema, Step, StepParams, ValidationIssue } from '../types/index.js';

export interface ExecutorOptions { signal: AbortSignal; }
export interface IStepExecutor {
    execute(step: Step, context: Record<string, unknown>, options: ExecutorOptions): Promise<unknown>;
}

export interface StepExecutorPlugin {
    type: string;
    executor: IStepExecutor;
    validate?: (params: StepParams, path: string) => ValidationIssue[];
    presentation?: {
        displayName: string;
        description?: string;
        parameterSchema?: JsonSchema;
        outputSchema?: JsonSchema;
    };
}
