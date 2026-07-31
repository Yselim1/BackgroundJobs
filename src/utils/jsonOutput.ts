import { AppError } from '../errors.js';

export function normalizeJsonOutput(value: unknown): unknown {
    if (value === undefined) return null;
    assertJsonValue(value, new Set<object>(), '$');
    try {
        return JSON.parse(JSON.stringify(value)) as unknown;
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        throw notSerializable(message);
    }
}

function assertJsonValue(value: unknown, ancestors: Set<object>, path: string): void {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw notSerializable(`${path} is not a finite number.`);
        return;
    }
    if (typeof value !== 'object') {
        throw notSerializable(`${path} contains unsupported value type ${typeof value}.`);
    }
    if (ancestors.has(value)) throw notSerializable(`${path} contains a circular reference.`);
    ancestors.add(value);
    if (Array.isArray(value)) {
        value.forEach((item, index) => assertJsonValue(item, ancestors, `${path}[${index}]`));
    } else {
        for (const [key, item] of Object.entries(value)) {
            assertJsonValue(item, ancestors, `${path}.${key}`);
        }
    }
    ancestors.delete(value);
}

function notSerializable(message: string): AppError {
    return new AppError('OUTPUT_NOT_SERIALIZABLE', `Step output is not JSON-serializable: ${message}`);
}
