import { type Step } from '../types/index.js';

export interface IStepExecutor {
    execute(step: Step, context: Record<string, any>): Promise<any>;
}