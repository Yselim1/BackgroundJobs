export { ExecutorRegistry } from '../executors/ExecutorRegistry.js';
export type {
    ExecutorOptions,
    IStepExecutor,
    StepExecutorPlugin
} from '../executors/IStepExecutor.js';
export type {
    FanOutDefinition,
    Step,
    StepParams,
    ValidationIssue,
    WorkflowCondition,
    WorkflowConditionOperator
} from '../types/index.js';

import { ExecutorRegistry, normalizePlugin } from '../executors/ExecutorRegistry.js';
import type { StepExecutorPlugin } from '../executors/IStepExecutor.js';

export function defineExecutorPlugin(plugin: StepExecutorPlugin): StepExecutorPlugin {
    return normalizePlugin(plugin);
}

export function registerExecutorPlugin(plugin: StepExecutorPlugin): () => void {
    return ExecutorRegistry.register(plugin);
}
