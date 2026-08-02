import { CommandExecutor } from './CommandExecutor.js';
import type { IStepExecutor, StepExecutorPlugin } from './IStepExecutor.js';
import { PythonExecutor } from './PythonExecutor.js';
import { RestApiExecutor } from './RestApiExecutor.js';
import { ScriptExecutor } from './ScriptExecutor.js';

const PLUGIN_TYPE = /^[A-Z][A-Z0-9_]*$/u;
const BUILTIN_PLUGINS: StepExecutorPlugin[] = [
    { type: 'RESTAPI', executor: new RestApiExecutor(), presentation: {
        displayName: 'REST API', description: 'Call an HTTP endpoint.',
        parameterSchema: { type: 'object', required: ['URL'], properties: {
            URL: { type: 'string' }, METHOD: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] },
            HEADERS: { type: 'object', additionalProperties: { type: 'string' } }, QUERY: { type: 'object' }, BODY: {},
            TIMEOUT_MS: { type: 'integer', minimum: 1 }, MAX_RESPONSE_BYTES: { type: 'integer', minimum: 1024, maximum: 10485760 },
            RESPONSE_TYPE: { type: 'string', enum: ['auto', 'json', 'text'] }
        }, additionalProperties: true },
        outputSchema: { type: 'object', properties: { status: { type: 'integer' }, statusText: { type: 'string' }, headers: { type: 'object' }, data: {} } }
    } },
    { type: 'SCRIPT', executor: new ScriptExecutor(), presentation: {
        displayName: 'JavaScript', description: 'Run JavaScript in the worker process.',
        parameterSchema: { type: 'object', required: ['CODE'], properties: { CODE: { type: 'string' }, TIMEOUT_MS: { type: 'integer', minimum: 1 } }, additionalProperties: true }
    } },
    { type: 'COMMAND', executor: new CommandExecutor(), presentation: {
        displayName: 'Command', description: 'Run a local command on the worker.',
        parameterSchema: { type: 'object', properties: {
            COMMAND: { type: 'string' }, EXECUTABLE: { type: 'string' }, ARGS: { type: 'array', items: { type: ['string', 'number', 'boolean', 'null'] } },
            CWD: { type: 'string' }, ENV: { type: 'object', additionalProperties: { type: 'string' } }, TIMEOUT_MS: { type: 'integer', minimum: 1 }
        }, oneOf: [{ required: ['COMMAND'] }, { required: ['EXECUTABLE'] }], additionalProperties: true }
    } },
    { type: 'PYTHON', executor: new PythonExecutor(), presentation: {
        displayName: 'Python', description: 'Run a Python snippet on the worker.',
        parameterSchema: { type: 'object', required: ['CODE'], properties: { CODE: { type: 'string' }, ENV: { type: 'object' }, TIMEOUT_MS: { type: 'integer', minimum: 1 } }, additionalProperties: true }
    } }
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

    static getCatalog(): Array<{ type: string; presentation: StepExecutorPlugin['presentation'] | null }> {
        return [...this.plugins.values()].map(plugin => ({ type: plugin.type, presentation: plugin.presentation ?? null }));
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
        ...(plugin.validate === undefined ? {} : { validate: plugin.validate }),
        ...(plugin.presentation === undefined ? {} : { presentation: structuredClone(plugin.presentation) })
    });
}

function normalizeType(type: string): string {
    return type.trim().toUpperCase();
}
