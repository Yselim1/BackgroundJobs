import { resolveContextTemplates } from '../utils/contextResolver.js';

const TEMPLATE = /\{\{[^{}]+\}\}/u;
const EXACT_SECRET_TEMPLATE = /^\{\{\s*secrets\.[A-Z][A-Z0-9_]{1,63}\s*\}\}$/u;

export function containsContextTemplate(value: string): boolean {
    return TEMPLATE.test(value);
}

export function assertLiteral(value: string, label: string): void {
    if (containsContextTemplate(value)) {
        throw new Error(`${label} must be literal and cannot contain context templates.`);
    }
}

export function resolveSafeEnvironment(
    value: unknown,
    context: Record<string, unknown>,
    label: string
): Record<string, string> {
    if (value === undefined) return {};
    if (!isRecord(value)) throw new Error(`${label} must be an object.`);
    const result: Record<string, string> = {};
    for (const [name, rawValue] of Object.entries(value)) {
        if (typeof rawValue !== 'string') throw new Error(`${label}.${name} must be a string.`);
        if (containsContextTemplate(rawValue) && !EXACT_SECRET_TEMPLATE.test(rawValue)) {
            throw new Error(`${label}.${name} may only use an exact managed-secret template.`);
        }
        const resolved = resolveContextTemplates(rawValue, context);
        if (typeof resolved !== 'string') throw new Error(`${label}.${name} must resolve to a string.`);
        result[name] = resolved;
    }
    return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
