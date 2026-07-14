import { type IStepExecutor } from './IStepExecutor.js';
import { RestApiExecutor } from './RestApiExecutor.js';
import { ScriptExecutor } from './ScriptExecutor.js';
import { CommandExecutor } from './CommandExecutor.js';
import { PythonExecutor } from './PythonExecutor.js';

export class ExecutorRegistry {
    static getExecutor(type: string): IStepExecutor {
        switch (type.toUpperCase()) {
            case 'RESTAPI': return new RestApiExecutor();
            case 'SCRIPT': return new ScriptExecutor();
            case 'COMMAND': return new CommandExecutor();
            case 'PYTHON': return new PythonExecutor();
            default: throw new Error(`Unsupported step type: ${type}`);
        }
    }
}