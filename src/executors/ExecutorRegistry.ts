import { type IStepExecutor } from './IStepExecutor.js';
import { RestApiExecutor } from './RestApiExecutor.js';
import { ScriptExecutor } from './ScriptExecutor.js';
import { CommandExecutor } from './CommandExecutor.js';
import { PythonExecutor } from './PythonExecutor.js';

const SUPPORTED_STEP_TYPES = [
    'RESTAPI',
    'SCRIPT',
    'COMMAND',
    'PYTHON'] as const;

export class ExecutorRegistry {
    static supports(type: unknown): boolean{
        if(typeof type !== 'string') return false;
        const normalizedType = type.trim().toUpperCase();
        return SUPPORTED_STEP_TYPES.some(supportedType => supportedType === normalizedType);
    }

    static getSupportedTypes(): readonly string[] {
        return SUPPORTED_STEP_TYPES;
    }

    static getExecutor(type: string): IStepExecutor {
        switch (type.trim().toUpperCase()) {
            case 'RESTAPI': return new RestApiExecutor();
            case 'SCRIPT': return new ScriptExecutor();
            case 'COMMAND': return new CommandExecutor();
            case 'PYTHON': return new PythonExecutor();
            default: throw new Error(`Unsupported step type: ${type}`);
        }
    }
}