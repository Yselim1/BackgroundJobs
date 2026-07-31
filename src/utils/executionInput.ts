import { AppError } from '../errors.js';
import { normalizeJsonOutput } from './jsonOutput.js';

export function normalizeExecutionInput(value: unknown): Record<string, unknown> {
    if (value === undefined) return {};
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new AppError('INVALID_EXECUTION_INPUT', 'input must be a JSON object.', 422);
    }
    try {
        const normalized = normalizeJsonOutput(value);
        if (normalized === null || typeof normalized !== 'object' || Array.isArray(normalized)) {
            throw new Error('the normalized value is not an object.');
        }
        return normalized as Record<string, unknown>;
    } catch (error: unknown) {
        throw new AppError(
            'INVALID_EXECUTION_INPUT',
            `input must be JSON-serializable: ${error instanceof Error ? error.message : String(error)}`,
            422
        );
    }
}
