import { AppError } from '../errors.js';

const REDACTED = '[REDACTED]';

export function redactManagedSecrets<T>(value: T, secrets: Record<string, string>): T {
    const sensitiveValues = values(secrets);
    if (sensitiveValues.length === 0) return value;
    return redactValue(value, sensitiveValues) as T;
}

export function redactManagedSecretError(error: Error, secrets: Record<string, string>): Error {
    const message = redactManagedSecretText(error.message, secrets);
    if (error instanceof AppError) {
        return new AppError(error.code, message, error.statusCode, error.details);
    }
    const sanitized = new Error(message);
    sanitized.name = error.name;
    return sanitized;
}

export function redactManagedSecretText(text: string, secrets: Record<string, string>): string {
    let sanitized = text;
    for (const secret of values(secrets)) sanitized = sanitized.split(secret).join(REDACTED);
    return sanitized;
}

function redactValue(value: unknown, sensitiveValues: string[]): unknown {
    if (typeof value === 'string') {
        let sanitized = value;
        for (const secret of sensitiveValues) sanitized = sanitized.split(secret).join(REDACTED);
        return sanitized;
    }
    if (Array.isArray(value)) return value.map(item => redactValue(item, sensitiveValues));
    if (value !== null && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
                .map(([key, item]) => [key, redactValue(item, sensitiveValues)])
        );
    }
    return value;
}

function values(secrets: Record<string, string>): string[] {
    return [...new Set(Object.values(secrets).filter(value => value.length > 0))]
        .sort((first, second) => second.length - first.length);
}
