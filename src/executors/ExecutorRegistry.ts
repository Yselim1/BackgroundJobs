import { CommandExecutor } from './CommandExecutor.js';
import type { IStepExecutor, StepExecutorPlugin } from './IStepExecutor.js';
import { PythonExecutor } from './PythonExecutor.js';
import { RestApiExecutor } from './RestApiExecutor.js';
import { ScriptExecutor } from './ScriptExecutor.js';

const PLUGIN_TYPE = /^[A-Z][A-Z0-9_]*$/u;
const BUILTIN_PLUGINS: StepExecutorPlugin[] = [
    { type: 'RESTAPI', executor: new RestApiExecutor() },
    { type: 'SCRIPT', executor: new ScriptExecutor() },
    { type: 'COMMAND', executor: new CommandExecutor() },
    { type: 'PYTHON', executor: new PythonExecutor() }
];

export class ExecutorRegistry {
    private static readonly plugins = new Map(
        BUILTIN_PLUGINS.map(plugin => {
            const normalized = normalizePlugin(plugin);
            return [normalized.type, normalized] as const;
        })
    );

    static supports(type: unknown): boolean {
        return typeof type === 'string' && this.plugins.has(normalizeType(type));
    }

    static getSupportedTypes(): readonly string[] {
        return [...this.plugins.keys()];
    }

    static getExecutor(type: string): IStepExecutor {
        const plugin = this.getPlugin(type);
        if (plugin === undefined) throw new Error(`Unsupported step type: ${type}`);
        return plugin.executor;
    }

    static getPlugin(type: string): StepExecutorPlugin | undefined {
        return this.plugins.get(normalizeType(type));
    }

    static register(plugin: StepExecutorPlugin): () => void {
        const normalized = normalizePlugin(plugin);
        if (this.plugins.has(normalized.type)) {
            throw new Error(`Executor type ${normalized.type} is already registered.`);
        }
        this.plugins.set(normalized.type, normalized);
        return () => {
            if (this.plugins.get(normalized.type) === normalized) this.plugins.delete(normalized.type);
        };
    }
}

export function normalizePlugin(plugin: StepExecutorPlugin): StepExecutorPlugin {
    if (plugin === null || typeof plugin !== 'object' || typeof plugin.type !== 'string') {
        throw new Error('Executor plugin must be an object with a string type.');
    }
    const type = normalizeType(plugin.type);
    if (!PLUGIN_TYPE.test(type)) {
        throw new Error('Plugin executor type must start with a letter and contain only A-Z, 0-9, and underscores.');
    }
    if (plugin.executor === null || typeof plugin.executor !== 'object' || typeof plugin.executor.execute !== 'function') {
        throw new Error(`Plugin executor ${type} must provide an execute function.`);
    }
    return Object.freeze({
        type,
        executor: plugin.executor,
        ...(plugin.validate === undefined ? {} : { validate: plugin.validate })
    });
}

function normalizeType(type: string): string {
    return type.trim().toUpperCase();
}
