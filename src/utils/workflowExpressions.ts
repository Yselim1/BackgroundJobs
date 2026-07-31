import { AppError } from '../errors.js';
import type { WorkflowCondition } from '../types/index.js';

const FORBIDDEN_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

export function evaluateWorkflowCondition(
    condition: WorkflowCondition,
    context: Record<string, unknown>
): boolean {
    const operator = condition.OPERATOR ?? 'truthy';
    const resolved = tryResolveWorkflowPath(condition.PATH, context);
    if (operator === 'exists') return resolved.found;
    if (operator === 'not_exists') return !resolved.found;
    if (!resolved.found) {
        throw new AppError(
            'CONDITION_PATH_NOT_FOUND',
            `Condition path ${condition.PATH} could not be resolved.`
        );
    }
    const value = resolved.value;
    switch (operator) {
        case 'truthy': return Boolean(value);
        case 'falsy': return !value;
        case 'equals': return jsonEqual(value, condition.VALUE);
        case 'not_equals': return !jsonEqual(value, condition.VALUE);
        case 'greater_than': return compare(value, condition.VALUE, comparison => comparison > 0);
        case 'greater_than_or_equal': return compare(value, condition.VALUE, comparison => comparison >= 0);
        case 'less_than': return compare(value, condition.VALUE, comparison => comparison < 0);
        case 'less_than_or_equal': return compare(value, condition.VALUE, comparison => comparison <= 0);
        case 'contains': return contains(value, condition.VALUE);
        default: throw new AppError('INVALID_CONDITION_OPERATOR', `Unsupported condition operator ${String(operator)}.`);
    }
}

export function resolveFanOutItems(path: string, context: Record<string, unknown>): unknown[] {
    const resolved = tryResolveWorkflowPath(path, context);
    if (!resolved.found) throw new AppError('FOREACH_PATH_NOT_FOUND', `FOREACH path ${path} could not be resolved.`);
    if (!Array.isArray(resolved.value)) {
        throw new AppError('FOREACH_NOT_ARRAY', `FOREACH path ${path} must resolve to an array.`);
    }
    return resolved.value;
}

export function getWorkflowPathRoot(path: string): string | undefined {
    return parsePath(path)[0];
}

export function isValidWorkflowPath(path: string): boolean {
    try {
        return parsePath(path).length > 0;
    } catch {
        return false;
    }
}

function tryResolveWorkflowPath(
    path: string,
    context: Record<string, unknown>
): { found: true; value: unknown } | { found: false } {
    const segments = parsePath(path);
    let value: unknown = context;
    for (const segment of segments) {
        if (
            value === null ||
            typeof value !== 'object' ||
            !Object.prototype.hasOwnProperty.call(value, segment)
        ) {
            return { found: false };
        }
        value = (value as Record<string, unknown>)[segment];
    }
    return { found: true, value };
}

function parsePath(path: string): string[] {
    const segments = path.split('.').map(segment => segment.trim());
    if (segments.length === 0 || segments.some(segment => segment.length === 0)) {
        throw new Error('Path must contain non-empty dot-separated segments.');
    }
    if (segments.some(segment => FORBIDDEN_PATH_SEGMENTS.has(segment))) {
        throw new Error('Path contains a forbidden segment.');
    }
    return segments;
}

function jsonEqual(left: unknown, right: unknown): boolean {
    if (Object.is(left, right)) return true;
    try {
        return JSON.stringify(left) === JSON.stringify(right);
    } catch {
        return false;
    }
}

function compare(left: unknown, right: unknown, predicate: (comparison: number) => boolean): boolean {
    if (typeof left === 'number' && typeof right === 'number') return predicate(left - right);
    if (typeof left === 'string' && typeof right === 'string') return predicate(left.localeCompare(right));
    return false;
}

function contains(container: unknown, expected: unknown): boolean {
    if (typeof container === 'string' && typeof expected === 'string') return container.includes(expected);
    if (Array.isArray(container)) return container.some(item => jsonEqual(item, expected));
    if (container !== null && typeof container === 'object' && typeof expected === 'string') {
        return Object.prototype.hasOwnProperty.call(container, expected);
    }
    return false;
}
