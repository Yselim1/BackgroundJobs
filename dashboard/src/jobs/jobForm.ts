import type { Job, JobDefinition, JobStep } from '../types';

const JOB_FIELDS = new Set([
    'id', 'name', 'description', 'status', 'schedule', 'timezone', 'TIMEOUT_MS',
    'MAX_CONCURRENCY', 'FAILURE_POLICY', 'DEFAULT_STEP_RETRY', 'STEPS',
    'last_run', 'next_run', 'created_at', 'updated_at'
]);
const STEP_FIELDS = new Set([
    'ORDER', 'ID', 'NAME', 'TYPE', 'DEPENDS_ON', 'STEP_PARAMS'
]);

export interface StepForm {
    key: string;
    id: string;
    name: string;
    type: string;
    dependencies: string;
    params: string;
    advanced: string;
}

export interface JobForm {
    id: string;
    name: string;
    description: string;
    status: 'active' | 'inactive';
    schedule: string;
    timezone: string;
    timeoutMs: string;
    maxConcurrency: string;
    failurePolicy: 'fail_fast' | 'continue_independent';
    retryMaxAttempts: string;
    retryDelayMs: string;
    retryBackoff: 'fixed' | 'exponential';
    advanced: string;
    steps: StepForm[];
}

export class JobFormError extends Error {
    constructor(readonly field: string, message: string) {
        super(message);
        this.name = 'JobFormError';
    }
}

let nextStepKey = 1;

export function createStepForm(type = 'SCRIPT'): StepForm {
    return {
        key: 'step-' + nextStepKey++,
        id: '',
        name: '',
        type,
        dependencies: '',
        params: JSON.stringify(defaultParams(type), null, 2),
        advanced: '{}'
    };
}

export function createJobForm(job?: Job): JobForm {
    if (job === undefined) {
        return {
            id: '',
            name: '',
            description: '',
            status: 'inactive',
            schedule: '',
            timezone: 'UTC',
            timeoutMs: '',
            maxConcurrency: '1',
            failurePolicy: 'fail_fast',
            retryMaxAttempts: '',
            retryDelayMs: '',
            retryBackoff: 'fixed',
            advanced: '{}',
            steps: [createStepForm()]
        };
    }

    const jobAdvanced = Object.fromEntries(
        Object.entries(job).filter(([key]) => !JOB_FIELDS.has(key))
    );
    return {
        id: job.id,
        name: job.name,
        description: typeof job.description === 'string' ? job.description : '',
        status: job.status,
        schedule: job.schedule ?? '',
        timezone: job.timezone,
        timeoutMs: job.TIMEOUT_MS?.toString() ?? '',
        maxConcurrency: job.MAX_CONCURRENCY?.toString() ?? '',
        failurePolicy: job.FAILURE_POLICY ?? 'fail_fast',
        retryMaxAttempts: job.DEFAULT_STEP_RETRY?.MAX_ATTEMPTS?.toString() ?? '',
        retryDelayMs: job.DEFAULT_STEP_RETRY?.DELAY_MS?.toString() ?? '',
        retryBackoff: job.DEFAULT_STEP_RETRY?.BACKOFF ?? 'fixed',
        advanced: JSON.stringify(jobAdvanced, null, 2),
        steps: job.STEPS.map(step => ({
            key: 'step-' + nextStepKey++,
            id: step.ID,
            name: step.NAME,
            type: step.TYPE,
            dependencies: step.DEPENDS_ON?.join(', ') ?? '',
            params: JSON.stringify(step.STEP_PARAMS, null, 2),
            advanced: JSON.stringify(
                Object.fromEntries(Object.entries(step).filter(([key]) => !STEP_FIELDS.has(key))),
                null,
                2
            )
        }))
    };
}

export function buildJobDefinition(form: JobForm): JobDefinition {
    const advanced = parseObject(form.advanced, 'advanced');
    const timeoutMs = optionalPositiveInteger(form.timeoutMs, 'TIMEOUT_MS');
    const maxConcurrency = optionalPositiveInteger(form.maxConcurrency, 'MAX_CONCURRENCY');
    const retryMaxAttempts = optionalPositiveInteger(form.retryMaxAttempts, 'DEFAULT_STEP_RETRY.MAX_ATTEMPTS');
    const retryDelayMs = optionalNonNegativeInteger(form.retryDelayMs, 'DEFAULT_STEP_RETRY.DELAY_MS');
    const hasRetry = retryMaxAttempts !== undefined || retryDelayMs !== undefined;

    return {
        ...advanced,
        id: form.id,
        name: form.name,
        ...(form.description.trim().length === 0 ? {} : { description: form.description }),
        status: form.status,
        ...(form.schedule.trim().length === 0 ? {} : { schedule: form.schedule }),
        timezone: form.timezone,
        ...(timeoutMs === undefined ? {} : { TIMEOUT_MS: timeoutMs }),
        ...(maxConcurrency === undefined ? {} : { MAX_CONCURRENCY: maxConcurrency }),
        FAILURE_POLICY: form.failurePolicy,
        ...(hasRetry ? {
            DEFAULT_STEP_RETRY: {
                ...(retryMaxAttempts === undefined ? {} : { MAX_ATTEMPTS: retryMaxAttempts }),
                ...(retryDelayMs === undefined ? {} : { DELAY_MS: retryDelayMs }),
                BACKOFF: form.retryBackoff
            }
        } : {}),
        STEPS: form.steps.map((step, index) => buildStep(step, index))
    } as JobDefinition;
}

export function stripJobReadOnly(job: Job): JobDefinition {
    const {
        last_run: _lastRun,
        next_run: _nextRun,
        created_at: _createdAt,
        updated_at: _updatedAt,
        ...definition
    } = job;
    return definition;
}

export function paramsForType(type: string): string {
    return JSON.stringify(defaultParams(type), null, 2);
}

function buildStep(form: StepForm, index: number): JobStep {
    const advanced = parseObject(form.advanced, `STEPS[${index}].advanced`);
    const dependencies = form.dependencies
        .split(',')
        .map(item => item.trim())
        .filter(item => item.length > 0);
    return {
        ...advanced,
        ORDER: index + 1,
        ID: form.id,
        NAME: form.name,
        TYPE: form.type,
        ...(dependencies.length === 0 ? {} : { DEPENDS_ON: dependencies }),
        STEP_PARAMS: parseObject(form.params, `STEPS[${index}].STEP_PARAMS`)
    };
}

function parseObject(value: string, field: string): Record<string, unknown> {
    try {
        const parsed = JSON.parse(value) as unknown;
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('must be a JSON object');
        }
        return parsed as Record<string, unknown>;
    } catch (error: unknown) {
        throw new JobFormError(
            field,
            `${field} must contain valid JSON object syntax: ${error instanceof Error ? error.message : String(error)}`
        );
    }
}

function optionalPositiveInteger(value: string, field: string): number | undefined {
    if (value.trim().length === 0) return undefined;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) {
        throw new JobFormError(field, `${field} must be a positive integer.`);
    }
    return parsed;
}

function optionalNonNegativeInteger(value: string, field: string): number | undefined {
    if (value.trim().length === 0) return undefined;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0) {
        throw new JobFormError(field, `${field} must be a non-negative integer.`);
    }
    return parsed;
}

function defaultParams(type: string): Record<string, unknown> {
    switch (type) {
        case 'RESTAPI':
            return { URL: 'https://example.com', METHOD: 'GET', TIMEOUT_MS: 10000 };
        case 'COMMAND':
            return { COMMAND: 'echo hello', TIMEOUT_MS: 10000 };
        case 'PYTHON':
            return { CODE: 'import json\nprint(json.dumps({\ok\: True}))', TIMEOUT_MS: 10000 };
        default:
            return { CODE: `() => ({ message: 'Hello from Workline' })` };
    }
}
