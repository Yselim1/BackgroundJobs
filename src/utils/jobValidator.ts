import {ExecutorRegistry } from '../executors/ExecutorRegistry.js';
import type{Job, JobValidationResult, ValidationIssue} from '../types/index.js';

const HTTP_METHODS = new Set([
    'GET',
    'POST',
    'PUT',
    'PATCH',
    'DELETE',
    'HEAD',
    'OPTIONS'
]);

const RESPONSE_TYPES = new Set([
    'auto',
    'json',
    'text'
]);

const FAILURE_POLICIES = new Set([
    'fail_fast',
    'continue_independent'
]);

const RETRY_BACKOFF_TYPES = new Set([
    'fixed',
    'exponential'
]);

export class JobValidationError extends Error {
    readonly issues: ValidationIssue[];

    constructor(issues: readonly ValidationIssue[]) {
        const summary = issues.map(issue => `${issue.path}: ${issue.message}`).join('; ');
        super(`Job definition validation failed: ${summary}`);
        this.name = 'JobValidationError';
        this.issues = [...issues];
    }
}

export function validateJobDefinition(input: unknown): JobValidationResult {
    const normalizedInput = normalizeJobDefinition(input);
    const errors: ValidationIssue[] = [];

    if(!isRecord(normalizedInput)) {
        addIssue(errors, '$', 'INVALID_JOB', 'Job definition must be an object.' );
    
        return { valid: false, errors };
    }

    validateRequiredString(normalizedInput.id, 'id', 'JOB_ID_REQUIRED', errors);
    validateRequiredString(normalizedInput.name, 'name', 'JOB_NAME_REQUIRED', errors);

    validateJobStatus(normalizedInput.status, errors);
    validateSchedule(normalizedInput.schedule, errors);
    validateExecutionSettings(normalizedInput, errors);

    const rawSteps = normalizedInput.STEPS;

    if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
        addIssue(errors, 'STEPS', 'STEPS_REQUIRED', 'STEPS must be a non-empty array.');

        return {valid: false, errors};
    }

    const stepIds = new Set<string>();
    const stepOrders = new Set<number>();

    for (let index = 0; index < rawSteps.length; index++) {
        const rawStep = rawSteps[index];
        const stepPath = `STEPS[${index}]`;

        if(!isRecord(rawStep)) {
            addIssue(errors, stepPath, 'INVALID_STEP', 'Step must be an object.');
            continue;
        }

        const stepId = rawStep.ID;
        const stepOrder = rawStep.ORDER;

        if(validateRequiredString(stepId, `${stepPath}.ID`, 'STEP_ID_REQUIRED', errors)){
            const normalizedStepId = stepId.trim();

            if(normalizedStepId.includes('.')) {
                addIssue(errors, `${stepPath}.ID`, 'INVALID_STEP_ID', 'Step ID cannot contain dots.');
            }

            if(stepIds.has(normalizedStepId)) {
                addIssue(errors, `${stepPath}.ID`, 'DUPLICATE_STEP_ID', `Duplicate step ID: "${normalizedStepId}".`);

            } else{
                stepIds.add(normalizedStepId);
            }
        }

        validateRequiredString(rawStep.NAME, `${stepPath}.NAME`, 'STEP_NAME_REQUIRED', errors);

        if(validateRequiredString(rawStep.TYPE, `${stepPath}.TYPE`, 'STEP_TYPE_REQUIRED', errors) 
                && !ExecutorRegistry.supports(rawStep.TYPE)
        ) {
            addIssue(errors, `${stepPath}.TYPE`, 'UNSUPPORTED_STEP_TYPE', `Unsupported step type: "${rawStep.TYPE}".`);
        }

        if(!Number.isInteger(stepOrder) || typeof stepOrder !== 'number' || stepOrder < 1){
            addIssue(errors, `${stepPath}.ORDER`, 'INVALID_STEP_ORDER', 'ORDER must be an integer greater than or equal to 1.');
        }else if (stepOrders.has(stepOrder)) {
            addIssue(errors, `${stepPath}.ORDER`, 'DUPLICATE_STEP_ORDER', `Duplicate step ORDER: ${stepOrder}.`);
        } else {
            stepOrders.add(stepOrder);
        }

        if(rawStep.FAIL_JOB_ON_FAILURE !== undefined && typeof rawStep.FAIL_JOB_ON_FAILURE !== 'boolean'){
            addIssue(errors, `${stepPath}.FAIL_JOB_ON_FAILURE`, 'INVALID_FAIL_JOB_ON_FAILURE', 'FAIL_JOB_ON_FAILURE must be a boolean.');
        }

        validateRetryPolicy(rawStep.RETRY, `${stepPath}.RETRY`, errors);

        validateStepParameters(rawStep, stepPath, errors);
    }
    
    validateDependencies(rawSteps, stepIds, errors);

    if (errors.length > 0){
        return {
            valid: false,
            errors
        };
    }

    return{
        valid: true,
        errors: [],
        job: normalizedInput as unknown as Job
    };
}

export function assertValidJobDefinition(input: unknown): Job {
    const result = validateJobDefinition(input);
    if (!result.valid) {
        throw new JobValidationError(result.errors);
    }
    return result.job;
}

function normalizeJobDefinition(input: unknown): unknown {
    if(!isRecord(input)) return input;

    const normalizedJob: Record<string, unknown> = {
        ...input
    };

    if(normalizedJob.status === undefined) {
        normalizedJob.status = 'active';
    }

    if(Array.isArray(input.STEPS)) {
        normalizedJob.STEPS = input.STEPS.map((rawStep, index): unknown => {
            if(!isRecord(rawStep)) {
                return rawStep;
            }

            const normalizedStep: Record<string, unknown> = {
                ...rawStep
            };

            if(normalizedStep.ID === undefined && typeof normalizedStep.NAME === 'string' && normalizedStep.NAME.trim().length > 0) {
                normalizedStep.ID = normalizedStep.NAME.trim();
            }

            if(normalizedStep.ORDER === undefined) {
                normalizedStep.ORDER = index + 1;
            }

            return normalizedStep;
        }
        );
    }
    return normalizedJob;
}

function validateJobStatus(value: unknown, errors: ValidationIssue[]): void {
    if (value !== 'active' && value !== 'inactive') {
        addIssue(errors, 'status', 'INVALID_JOB_STATUS', 'status must be either "active" or "inactive".');
    }
}

function validateSchedule(value: unknown, errors: ValidationIssue[]): void {
    if(value === undefined ) return;

    if(typeof value !== 'string' || value.trim().length === 0) {
        addIssue(errors, 'schedule', 'INVALID_SCHEDULE', 'schedule must be a non-empty string.');
    }
}

function validateExecutionSettings(job: Record<string, unknown>, errors: ValidationIssue[]): void {
    if(job.MAX_CONCURRENCY !== undefined 
        && (typeof job.MAX_CONCURRENCY !== 'number' ||
            !Number.isInteger(job.MAX_CONCURRENCY) ||
            job.MAX_CONCURRENCY < 1
        )
    ) {
        addIssue(errors, 'MAX_CONCURRENCY', 'INVALID_MAX_CONCURRENCY', 'MAX_CONCURRENCY must be an integer greater than or equal to 1.');
    } 

    if(job.FAILURE_POLICY !== undefined 
        &&(typeof job.FAILURE_POLICY !== 'string' || !FAILURE_POLICIES.has(job.FAILURE_POLICY))
    ) {
        addIssue(errors, 'FAILURE_POLICY', 'INVALID_FAILURE_POLICY', 'FAILURE_POLICY must be "fail_fast" or "continue_independent".');
    }

    validateRetryPolicy(job.DEFAULT_STEP_RETRY, 'DEFAULT_STEP_RETRY', errors);
}

function validateRetryPolicy(value: unknown, path: string, errors: ValidationIssue[]): void {
    if (value === undefined) return;

    if (!isRecord(value)) {
        addIssue(errors, path, 'INVALID_RETRY_POLICY', 'Retry policy must be an object.');
        return;
    }

    if (value.MAX_ATTEMPTS !== undefined &&
        (typeof value.MAX_ATTEMPTS !== 'number' ||
         !Number.isInteger(value.MAX_ATTEMPTS) ||
         value.MAX_ATTEMPTS < 1
        )
    ) {
        addIssue(errors, `${path}.MAX_ATTEMPTS`, 'INVALID_MAX_ATTEMPTS', 'MAX_ATTEMPTS must be an integer greater than or equal to 1.');
    }

    if (value.DELAY_MS !== undefined &&
        (typeof value.DELAY_MS !== 'number' ||
         !Number.isFinite(value.DELAY_MS) ||
         value.DELAY_MS < 0
        )
    ) {
        addIssue(errors, `${path}.DELAY_MS`, 'INVALID_RETRY_DELAY', 'DELAY_MS must be a non-negative number.');
    }

    if (value.BACKOFF !== undefined &&
        (typeof value.BACKOFF !== 'string' ||
         !RETRY_BACKOFF_TYPES.has(value.BACKOFF)
        )
    ) {
        addIssue(errors, `${path}.BACKOFF`, 'INVALID_RETRY_BACKOFF', 'BACKOFF must be "fixed" or "exponential".');
    }
}

function validateDependencies(rawSteps: unknown[], stepIds: ReadonlySet<string>, errors: ValidationIssue[]): void {
    for (let index = 0; index < rawSteps.length; index++) {
        const rawStep = rawSteps[index];

        if (!isRecord(rawStep)) continue;

        const dependencies = rawStep.DEPENDS_ON;
        const stepPath = `STEPS[${index}]`;
        
        if (dependencies === undefined) {
            continue;
        }

        if (!Array.isArray(dependencies)) {
            addIssue(errors, `${stepPath}.DEPENDS_ON`, 'INVALID_DEPENDENCIES', 'DEPENDS_ON must be an array of step IDs.');
            continue;
        }

        const encounteredDependencies = new Set<string>();

        for (let dependencyIndex = 0; dependencyIndex < dependencies.length; dependencyIndex++) {
            const dependency = dependencies[dependencyIndex];
            const dependencyPath = `${stepPath}.DEPENDS_ON[${dependencyIndex}]`;

            if (typeof dependency !== 'string' || dependency.trim().length === 0) {
                addIssue(errors, dependencyPath, 'INVALID_DEPENDENCY', 'Dependency must be a non-empty step ID.');
                continue;
            }

            const dependencyId = dependency.trim();

            if (encounteredDependencies.has(dependencyId)) {
                  addIssue(errors, dependencyPath, 'DUPLICATE_DEPENDENCY', `Dependency "${dependencyId}" is listed more than once.`);
                  continue;
            }

            encounteredDependencies.add(dependencyId);

            if (dependencyId === rawStep.ID) {
                addIssue(errors, dependencyPath, 'SELF_DEPENDENCY', `Step "${dependencyId}" cannot depend on itself.`);
            } else if (!stepIds.has(dependencyId)) {
                addIssue(errors, dependencyPath, 'MISSING_DEPENDENCY', `Dependency step "${dependencyId}" does not exist.`);
            }
          }
      }
  }

function validateStepParameters(step: Record<string, unknown>, stepPath: string, errors: ValidationIssue[]): void {
    const params = step.STEP_PARAMS;
    const paramsPath = `${stepPath}.STEP_PARAMS`;

    if (!isRecord(params)) {
        addIssue(errors, paramsPath, 'STEP_PARAMS_REQUIRED', 'STEP_PARAMS must be an object.');
        return;
    }

    if (typeof step.TYPE !== 'string') return;

    switch (step.TYPE.trim().toUpperCase()) {
        case 'RESTAPI':
            validateRestApiParameters(params, paramsPath, errors);
            break;

        case 'COMMAND':
            validateCommandParameters(params, paramsPath, errors);
            break;

        case 'SCRIPT':
        case 'PYTHON':
            validateCodeParameters(params, paramsPath, errors);
            break;
      }
  }

function validateRestApiParameters(params: Record<string, unknown>, path: string, errors: ValidationIssue[]): void {
    validateRequiredString(params.URL, `${path}.URL`, 'REST_URL_REQUIRED', errors);

    let method = 'GET';

    if (params.METHOD !== undefined) {
        if (typeof params.METHOD !== 'string') {
            addIssue(errors, `${path}.METHOD`, 'INVALID_HTTP_METHOD', 'METHOD must be a string.');
        } else {
            method = params.METHOD.trim().toUpperCase();
            if (!HTTP_METHODS.has(method)) {
                addIssue(errors, `${path}.METHOD`, 'UNSUPPORTED_HTTP_METHOD', `Unsupported HTTP method: "${params.METHOD}".`);
            }
        }
    }

    if (params.TIMEOUT_MS !== undefined && (typeof params.TIMEOUT_MS !== 'number' || !Number.isInteger(params.TIMEOUT_MS) || params.TIMEOUT_MS < 1)) {
        addIssue(errors, `${path}.TIMEOUT_MS`, 'INVALID_TIMEOUT', 'TIMEOUT_MS must be a positive integer.');
    }

    if (params.RESPONSE_TYPE !== undefined && (typeof params.RESPONSE_TYPE !== 'string' || !RESPONSE_TYPES.has(params.RESPONSE_TYPE))) {
        addIssue(errors, `${path}.RESPONSE_TYPE`, 'INVALID_RESPONSE_TYPE', 'RESPONSE_TYPE must be "auto", "json", or "text".');
    }

    if ((method === 'GET' || method === 'HEAD') && params.BODY !== undefined) {
        addIssue(errors, `${path}.BODY`, 'BODY_NOT_ALLOWED', `${method} requests cannot contain BODY.`);
    }

    validateScalarRecord(params.HEADERS, `${path}.HEADERS`, errors);
    validateQuery(params.QUERY, `${path}.QUERY`, errors);
    validateCapturedHeaders(params.CAPTURE_RESPONSE_HEADERS, `${path}.CAPTURE_RESPONSE_HEADERS`, errors);
}

function validateCommandParameters(params: Record<string, unknown>, path: string, errors: ValidationIssue[]): void {
    validateRequiredString(params.COMMAND, `${path}.COMMAND`, 'COMMAND_REQUIRED', errors);

    if (params.TIMEOUT_MS !== undefined && (typeof params.TIMEOUT_MS !== 'number' || !Number.isInteger(params.TIMEOUT_MS) || params.TIMEOUT_MS < 1)) {
        addIssue(errors, `${path}.TIMEOUT_MS`, 'INVALID_TIMEOUT', 'TIMEOUT_MS must be a positive integer.');
    }

    if (params.CWD !== undefined && (typeof params.CWD !== 'string' || params.CWD.trim().length === 0)) {
        addIssue(errors, `${path}.CWD`, 'INVALID_WORKING_DIRECTORY', 'CWD must be a non-empty string.');
    }

    if (params.ENV !== undefined) {
        if (!isRecord(params.ENV)) {
            addIssue(errors, `${path}.ENV`, 'INVALID_ENV', 'ENV must be an object.');
        } else {
            for (const [name, value] of Object.entries(params.ENV)) {
                if (typeof value !== 'string') {
                    addIssue(errors, `${path}.ENV.${name}`, 'INVALID_ENV_VALUE', 'Environment variable values must be strings.');
                }
            }
        }
    }
}

function validateCodeParameters(params: Record<string, unknown>, path: string, errors: ValidationIssue[]): void {
    validateRequiredString(params.CODE, `${path}.CODE`, 'CODE_REQUIRED', errors);
}

function validateScalarRecord(value: unknown, path: string, errors: ValidationIssue[]): void {
    if (value === undefined) return;

    if (!isRecord(value)) {
        addIssue(errors, path, 'INVALID_OBJECT', `${path} must be an object.`);
        return;
    }

    for (const [name, item] of Object.entries(value)) {
        if (!isScalar(item)) {
            addIssue(errors, `${path}.${name}`, 'INVALID_SCALAR_VALUE', 'Value must be a string, number, or boolean.');
        }
    }
}

function validateQuery(value: unknown, path: string, errors: ValidationIssue[]): void {
    if (value === undefined) return;

    if (!isRecord(value)) {
        addIssue(errors, path, 'INVALID_QUERY', 'QUERY must be an object.');
        return;
    }

    for (const [name, item] of Object.entries(value)) {
        const valid = isQueryPrimitive(item) || (Array.isArray(item) && item.every(arrayItem => isQueryPrimitive(arrayItem)) );

        if (!valid) {
            addIssue(errors, `${path}.${name}`, 'INVALID_QUERY_VALUE', 'Query value must be a primitive or an array of primitives.');
        }
    }
}

function validateCapturedHeaders(value: unknown, path: string, errors: ValidationIssue[]): void {
    if (value === undefined) return;

    if (!Array.isArray(value)) {
        addIssue(errors, path, 'INVALID_CAPTURE_HEADERS', 'CAPTURE_RESPONSE_HEADERS must be an array.');
        return;
    }

    value.forEach((headerName, index) => {
        if (typeof headerName !== 'string' || headerName.trim().length === 0) {
            addIssue(errors, `${path}[${index}]`, 'INVALID_HEADER_NAME', 'Captured header name must be a non-empty string.');
        }
    });
}

function validateRequiredString(value: unknown, path: string, code: string, errors: ValidationIssue[]): value is string {
    if (typeof value === 'string' && value.trim().length > 0) return true;
    addIssue(errors, path, code, 'Value must be a non-empty string.');
    return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return(typeof value === 'object' && value !== null && !Array.isArray(value));
}

function isScalar(value: unknown): value is string | number | boolean {
    return (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean');
}

function isQueryPrimitive(value: unknown): value is string | number | boolean | null {
    return value === null || isScalar(value);
}

function addIssue(errors: ValidationIssue[], path: string, code: string, message: string): void {
    errors.push({path, code, message});
}