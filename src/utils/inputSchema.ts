import * as Ajv2020Module from 'ajv/dist/2020.js';
import type { ErrorObject, ValidateFunction } from 'ajv/dist/2020.js';
import { AppError } from '../errors.js';
import type { Job, JsonSchema, ValidationIssue } from '../types/index.js';
import { normalizeExecutionInput } from './executionInput.js';

const ajv = new Ajv2020Module.Ajv2020({ allErrors: true, strict: true, validateFormats: false });
const validators = new WeakMap<JsonSchema, ValidateFunction>();

export function validateInputSchema(schema: unknown, path = 'INPUT_SCHEMA'): ValidationIssue[] {
    if (!isRecord(schema)) return [{ path, code: 'INVALID_INPUT_SCHEMA', message: 'INPUT_SCHEMA must be a JSON Schema object.' }];
    if (schema.type !== 'object') {
        return [{ path: `${path}.type`, code: 'INPUT_SCHEMA_MUST_DESCRIBE_OBJECT', message: 'INPUT_SCHEMA type must be object.' }];
    }
    try {
        ajv.compile(schema);
        return [];
    } catch (error: unknown) {
        return [{ path, code: 'INVALID_INPUT_SCHEMA', message: error instanceof Error ? error.message : String(error) }];
    }
}

export function validateJobInput(job: Job, input: unknown): Record<string, unknown> {
    const normalized = normalizeExecutionInput(input);
    if (job.INPUT_SCHEMA === undefined) return normalized;
    const validator = inputValidator(job.INPUT_SCHEMA);
    if (!validator(normalized)) {
        throw new AppError('EXECUTION_INPUT_SCHEMA_FAILED', 'Execution input does not match INPUT_SCHEMA.', 422, {
            issues: mapAjvErrors(validator.errors)
        });
    }
    return normalized;
}

function inputValidator(schema: JsonSchema): ValidateFunction {
    const existing = validators.get(schema);
    if (existing !== undefined) return existing;
    try {
        const compiled = ajv.compile(schema);
        validators.set(schema, compiled);
        return compiled;
    } catch (error: unknown) {
        throw new AppError('INVALID_INPUT_SCHEMA', `Stored INPUT_SCHEMA cannot be compiled: ${error instanceof Error ? error.message : String(error)}`, 500);
    }
}

export function resolveJobInput(job: Job, suppliedInput: unknown, supplied: boolean): Record<string, unknown> {
    const value = supplied ? suppliedInput : job.DEFAULT_INPUT ?? {};
    return validateJobInput(job, value);
}

export function defaultInputIssues(job: Pick<Job, 'INPUT_SCHEMA' | 'DEFAULT_INPUT'>): ValidationIssue[] {
    if (job.DEFAULT_INPUT === undefined) return [];
    if (job.INPUT_SCHEMA === undefined) {
        try {
            normalizeExecutionInput(job.DEFAULT_INPUT);
            return [];
        } catch (error: unknown) {
            return [{ path: 'DEFAULT_INPUT', code: 'INVALID_DEFAULT_INPUT', message: error instanceof Error ? error.message : String(error) }];
        }
    }
    try {
        validateJobInput(job as Job, job.DEFAULT_INPUT);
        return [];
    } catch (error: unknown) {
        if (error instanceof AppError && isRecord(error.details) && Array.isArray(error.details.issues)) {
            return error.details.issues.map((issue: unknown) => {
                const item = isRecord(issue) ? issue : {};
                return {
                    path: `DEFAULT_INPUT${typeof item.path === 'string' && item.path !== '$' ? item.path.slice(1) : ''}`,
                    code: 'DEFAULT_INPUT_SCHEMA_FAILED',
                    message: typeof item.message === 'string' ? item.message : 'DEFAULT_INPUT does not match INPUT_SCHEMA.'
                };
            });
        }
        return [{ path: 'DEFAULT_INPUT', code: 'INVALID_DEFAULT_INPUT', message: error instanceof Error ? error.message : String(error) }];
    }
}

function mapAjvErrors(errors: ErrorObject[] | null | undefined): ValidationIssue[] {
    return (errors ?? []).map(error => ({
        path: error.instancePath.length === 0 ? '$' : `$${error.instancePath.replaceAll('/', '.')}`,
        code: `INPUT_${error.keyword.toUpperCase()}`,
        message: error.message ?? `Input failed ${error.keyword} validation.`
    }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
