import {ExecutorRegistry } from '../executors/ExecutorRegistry.js';
import type{Job, JobValidationResult, ValidationIssue, WorkflowConditionOperator} from '../types/index.js';
import {findDependencyCycle, type DependencyNode} from './jobGraph.js';
import { assertValidCron, assertValidTimezone } from './cron.js';
import { getWorkflowPathRoot, isValidWorkflowPath } from './workflowExpressions.js';
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

const WEBHOOK_EVENTS = new Set(['success', 'failed', 'cancelled', 'skipped']);
const CONDITION_OPERATORS = new Set<WorkflowConditionOperator>([
    'equals', 'not_equals', 'exists', 'not_exists', 'truthy', 'falsy',
    'greater_than', 'greater_than_or_equal', 'less_than', 'less_than_or_equal', 'contains'
]);
const VALUE_CONDITION_OPERATORS = new Set<WorkflowConditionOperator>([
    'equals', 'not_equals', 'greater_than', 'greater_than_or_equal',
    'less_than', 'less_than_or_equal', 'contains'
]);
const RESERVED_CONTEXT_ROOTS = new Set(['input', 'secrets', 'item', 'index']);
const SECRET_NAME = /^[A-Z][A-Z0-9_]{1,63}$/u;
const SECRET_TEMPLATE = /\{\{\s*secrets\.([^{}\s]+)\s*\}\}/gu;
const QUEUE_NAME = /^[a-z][a-z0-9_-]{0,63}$/u;

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

    if (Object.hasOwn(normalizedInput, 'last_run')) {
        addIssue(errors, 'last_run', 'READ_ONLY_FIELD', 'last_run is read-only.');
    }
    if (Object.hasOwn(normalizedInput, 'next_run')) {
        addIssue(errors, 'next_run', 'READ_ONLY_FIELD', 'next_run is read-only.');
    }
    if (Object.hasOwn(normalizedInput, 'version')) {
        addIssue(errors, 'version', 'READ_ONLY_FIELD', 'version is read-only.');
    }
    validateJobStatus(normalizedInput.status, errors);
    validateSchedule(normalizedInput.schedule, normalizedInput.timezone, errors);
    validateExecutionSettings(normalizedInput, errors);
    validateSecretTemplates(normalizedInput, '$', errors);

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

            if (RESERVED_CONTEXT_ROOTS.has(normalizedStepId)) {
                addIssue(errors, `${stepPath}.ID`, 'RESERVED_STEP_ID', `Step ID "${normalizedStepId}" is a reserved context root.`);
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
        validateWorkflowShape(rawStep, stepPath, errors);

        validateStepParameters(rawStep, stepPath, errors);
    }
    
    validateDependencies(rawSteps, stepIds, errors);
    validateWorkflowReferences(rawSteps, stepIds, errors);
    const dependencyNodes = buildDependencyNodes(rawSteps);

    if (dependencyNodes !== undefined) {
        const dependencyCycle =
        findDependencyCycle(dependencyNodes);

        if (dependencyCycle !== undefined) {
            addIssue(errors, 'STEPS', 'CIRCULAR_DEPENDENCY', `Circular dependency detected: ${dependencyCycle.join(' -> ')}`);
        }
    }
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

function buildDependencyNodes(rawSteps: unknown[]): DependencyNode[] | undefined {
    const nodes: DependencyNode[] = [];
    const encounteredIds = new Set<string>();

    for (const rawStep of rawSteps) {
        if (!isRecord(rawStep) || typeof rawStep.ID !== 'string' || rawStep.ID.trim().length === 0) {
            return undefined;
        }

        const stepId = rawStep.ID.trim();

        // Graph analysis would be ambiguous when IDs are duplicated.
        // Duplicate IDs are already reported by the regular validator.
        if (encounteredIds.has(stepId)) {
            return undefined;
        }

        encounteredIds.add(stepId);

        const rawDependencies = rawStep.DEPENDS_ON;

        if (rawDependencies !== undefined && !Array.isArray(rawDependencies)) {
            return undefined;
        }

        const dependencies = (rawDependencies ?? []).flatMap(dependency => {
            if (typeof dependency !== 'string' || dependency.trim().length === 0) {
                return [];
            }

            return [dependency.trim()];
        });

        nodes.push({id: stepId, dependsOn: dependencies});
    }

    return nodes;
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

    if (typeof normalizedJob.id === 'string') {
          normalizedJob.id = normalizedJob.id.trim();
    }
    if (typeof normalizedJob.name === 'string') {
        normalizedJob.name = normalizedJob.name.trim();
    }
    if (typeof normalizedJob.schedule === 'string') {
        normalizedJob.schedule =
            normalizedJob.schedule.trim();
    }
    if (typeof normalizedJob.status === 'string') {
        normalizedJob.status =
            normalizedJob.status.trim();
    }

    if(normalizedJob.status === undefined) {
        normalizedJob.status = 'active';
    }
    if (typeof normalizedJob.QUEUE === 'string') normalizedJob.QUEUE = normalizedJob.QUEUE.trim().toLowerCase();

    if (typeof normalizedJob.timezone === 'string') {
        normalizedJob.timezone = normalizedJob.timezone.trim();
    }
    if (normalizedJob.timezone === undefined) {
        normalizedJob.timezone = 'UTC';
    }

    if(Array.isArray(input.STEPS)) {
        normalizedJob.STEPS = input.STEPS.map((rawStep, index): unknown => {
            if(!isRecord(rawStep)) {
                return rawStep;
            }

            const normalizedStep: Record<string, unknown> = {
                ...rawStep
            };

            if (typeof normalizedStep.NAME === 'string') {
                normalizedStep.NAME = normalizedStep.NAME.trim();
            }

            if (typeof normalizedStep.ID === 'string') {
                normalizedStep.ID = normalizedStep.ID.trim();
            }

            if (normalizedStep.ID === undefined && typeof normalizedStep.NAME === 'string' && normalizedStep.NAME.length > 0) {
                normalizedStep.ID = normalizedStep.NAME;
            }

            if (typeof normalizedStep.TYPE === 'string') {
                normalizedStep.TYPE =normalizedStep.TYPE.trim().toUpperCase();
            }

            if (normalizedStep.ORDER === undefined) {
                normalizedStep.ORDER = index + 1;
            }

            if (Array.isArray(normalizedStep.DEPENDS_ON)) {
                normalizedStep.DEPENDS_ON = normalizedStep.DEPENDS_ON.map(dependency => {
                    if (typeof dependency === 'string') {
                        return dependency.trim();
                    }
                    return dependency;
                });
            }

            if (isRecord(normalizedStep.WHEN)) {
                normalizedStep.WHEN = {
                    ...normalizedStep.WHEN,
                    ...(typeof normalizedStep.WHEN.PATH === 'string' ? { PATH: normalizedStep.WHEN.PATH.trim() } : {}),
                    ...(typeof normalizedStep.WHEN.OPERATOR === 'string' ? { OPERATOR: normalizedStep.WHEN.OPERATOR.trim().toLowerCase() } : {})
                };
            }
            if (isRecord(normalizedStep.FOREACH)) {
                normalizedStep.FOREACH = {
                    ...normalizedStep.FOREACH,
                    ...(typeof normalizedStep.FOREACH.ITEMS === 'string' ? { ITEMS: normalizedStep.FOREACH.ITEMS.trim() } : {})
                };
            }

            return normalizedStep;
        });
    }
    if (Array.isArray(input.WEBHOOKS)) {
        normalizedJob.WEBHOOKS = input.WEBHOOKS.map(rawWebhook => {
            if (!isRecord(rawWebhook)) return rawWebhook;
            return {
                ...rawWebhook,
                ...(typeof rawWebhook.URL === 'string' ? { URL: rawWebhook.URL.trim() } : {}),
                ...(typeof rawWebhook.SIGNING_SECRET === 'string'
                    ? { SIGNING_SECRET: rawWebhook.SIGNING_SECRET.trim().toUpperCase() }
                    : {})
            };
        });
    }
    return normalizedJob;
}

function validateJobStatus(value: unknown, errors: ValidationIssue[]): void {
    if (value !== 'active' && value !== 'inactive') {
        addIssue(errors, 'status', 'INVALID_JOB_STATUS', 'status must be either "active" or "inactive".');
    }
}

function validateSchedule(value: unknown, timezoneValue: unknown, errors: ValidationIssue[]): void {
    if (typeof timezoneValue !== 'string' || timezoneValue.trim().length === 0) {
        addIssue(errors, 'timezone', 'INVALID_TIMEZONE', 'timezone must be a non-empty IANA timezone identifier.');
        return;
    }
    try {
        assertValidTimezone(timezoneValue);
    } catch (error: unknown) {
        addIssue(errors, 'timezone', 'INVALID_TIMEZONE', error instanceof Error ? error.message : String(error));
        return;
    }
    if (value === undefined) return;
    if (typeof value !== 'string' || value.trim().length === 0) {
        addIssue(errors, 'schedule', 'INVALID_SCHEDULE', 'schedule must be a non-empty string.');
        return;
    }
    try {
        assertValidCron(value, timezoneValue);
    } catch (error: unknown) {
        addIssue(errors, 'schedule', 'INVALID_SCHEDULE', error instanceof Error ? error.message : String(error));
    }
}

function validateExecutionSettings(job: Record<string, unknown>, errors: ValidationIssue[]): void {
    if (job.QUEUE !== undefined && (typeof job.QUEUE !== 'string' || !QUEUE_NAME.test(job.QUEUE))) {
        addIssue(errors, 'QUEUE', 'INVALID_QUEUE', 'QUEUE must start with a lowercase letter and contain only lowercase letters, numbers, underscores, or hyphens.');
    }
    if (job.PRIORITY !== undefined && (typeof job.PRIORITY !== 'number' || !Number.isInteger(job.PRIORITY) || job.PRIORITY < -100 || job.PRIORITY > 100)) {
        addIssue(errors, 'PRIORITY', 'INVALID_PRIORITY', 'PRIORITY must be an integer between -100 and 100.');
    }
    if (job.TIMEOUT_MS !== undefined &&
        (typeof job.TIMEOUT_MS !== 'number' || !Number.isInteger(job.TIMEOUT_MS) || job.TIMEOUT_MS <= 0)
    ) {
        addIssue(errors, 'TIMEOUT_MS', 'INVALID_JOB_TIMEOUT', 'TIMEOUT_MS must be a positive integer.');
    }
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
    validateWebhooks(job.WEBHOOKS, errors);
}

function validateWebhooks(value: unknown, errors: ValidationIssue[]): void {
    if (value === undefined) return;
    if (!Array.isArray(value) || value.length === 0) {
        addIssue(errors, 'WEBHOOKS', 'INVALID_WEBHOOKS', 'WEBHOOKS must be a non-empty array when provided.');
        return;
    }
    if (value.length > 10) {
        addIssue(errors, 'WEBHOOKS', 'TOO_MANY_WEBHOOKS', 'A job may define at most 10 webhooks.');
    }
    value.forEach((item, index) => {
        const path = `WEBHOOKS[${index}]`;
        if (!isRecord(item)) {
            addIssue(errors, path, 'INVALID_WEBHOOK', 'Webhook must be an object.');
            return;
        }
        if (!validateRequiredString(item.URL, `${path}.URL`, 'WEBHOOK_URL_REQUIRED', errors)) return;
        try {
            const url = new URL(item.URL);
            if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('unsupported protocol');
        } catch {
            addIssue(errors, `${path}.URL`, 'INVALID_WEBHOOK_URL', 'Webhook URL must be an absolute HTTP or HTTPS URL.');
        }
        if (item.EVENTS !== undefined) {
            if (!Array.isArray(item.EVENTS) || item.EVENTS.length === 0) {
                addIssue(errors, `${path}.EVENTS`, 'INVALID_WEBHOOK_EVENTS', 'EVENTS must be a non-empty array.');
            } else {
                const encountered = new Set<string>();
                item.EVENTS.forEach((event, eventIndex) => {
                    if (typeof event !== 'string' || !WEBHOOK_EVENTS.has(event)) {
                        addIssue(errors, `${path}.EVENTS[${eventIndex}]`, 'INVALID_WEBHOOK_EVENT', 'Webhook event must be success, failed, cancelled, or skipped.');
                    } else if (encountered.has(event)) {
                        addIssue(errors, `${path}.EVENTS[${eventIndex}]`, 'DUPLICATE_WEBHOOK_EVENT', `Duplicate webhook event: ${event}.`);
                    } else encountered.add(event);
                });
            }

        }
        if (item.SIGNING_SECRET !== undefined &&
            (typeof item.SIGNING_SECRET !== 'string' || !SECRET_NAME.test(item.SIGNING_SECRET))) {
            addIssue(
                errors,
                `${path}.SIGNING_SECRET`,
                'INVALID_SIGNING_SECRET',
                'SIGNING_SECRET must be a valid managed secret name.'
            );
        }
    });
}

function validateSecretTemplates(value: unknown, path: string, errors: ValidationIssue[]): void {
    if (typeof value === 'string') {
        for (const match of value.matchAll(SECRET_TEMPLATE)) {
            if (!SECRET_NAME.test(match[1] as string)) {
                addIssue(errors, path, 'INVALID_SECRET_REFERENCE', 'Managed secret references must use uppercase secret names.');
            }
        }
        return;
    }
    if (Array.isArray(value)) {
        value.forEach((item, index) => validateSecretTemplates(item, `${path}[${index}]`, errors));
        return;
    }
    if (isRecord(value)) {
        for (const [key, item] of Object.entries(value)) {
            validateSecretTemplates(item, path === '$' ? key : `${path}.${key}`, errors);
        }
    }
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

function validateWorkflowShape(step: Record<string, unknown>, path: string, errors: ValidationIssue[]): void {
    if (step.WHEN !== undefined) {
        if (!isRecord(step.WHEN)) {
            addIssue(errors, `${path}.WHEN`, 'INVALID_CONDITION', 'WHEN must be an object.');
        } else {
            const conditionPath = step.WHEN.PATH;
            const pathValid = validateRequiredString(conditionPath, `${path}.WHEN.PATH`, 'CONDITION_PATH_REQUIRED', errors);
            if (pathValid && !isValidWorkflowPath(conditionPath)) {
                addIssue(errors, `${path}.WHEN.PATH`, 'INVALID_WORKFLOW_PATH', 'Condition path must use safe, non-empty dot-separated segments.');
            }
            const operator = step.WHEN.OPERATOR ?? 'truthy';
            if (typeof operator !== 'string' || !CONDITION_OPERATORS.has(operator as WorkflowConditionOperator)) {
                addIssue(errors, `${path}.WHEN.OPERATOR`, 'INVALID_CONDITION_OPERATOR', 'Unsupported condition operator.');
            } else if (VALUE_CONDITION_OPERATORS.has(operator as WorkflowConditionOperator) && !Object.hasOwn(step.WHEN, 'VALUE')) {
                addIssue(errors, `${path}.WHEN.VALUE`, 'CONDITION_VALUE_REQUIRED', `VALUE is required for operator ${operator}.`);
            }
        }
    }
    if (step.FOREACH !== undefined) {
        if (!isRecord(step.FOREACH)) {
            addIssue(errors, `${path}.FOREACH`, 'INVALID_FOREACH', 'FOREACH must be an object.');
        } else {
            const itemsPath = step.FOREACH.ITEMS;
            const itemsValid = validateRequiredString(itemsPath, `${path}.FOREACH.ITEMS`, 'FOREACH_ITEMS_REQUIRED', errors);
            if (itemsValid && !isValidWorkflowPath(itemsPath)) {
                addIssue(errors, `${path}.FOREACH.ITEMS`, 'INVALID_WORKFLOW_PATH', 'FOREACH ITEMS must use safe, non-empty dot-separated segments.');
            }
            if (
                step.FOREACH.MAX_CONCURRENCY !== undefined &&
                (typeof step.FOREACH.MAX_CONCURRENCY !== 'number' ||
                    !Number.isInteger(step.FOREACH.MAX_CONCURRENCY) ||
                    step.FOREACH.MAX_CONCURRENCY < 1)
            ) {
                addIssue(errors, `${path}.FOREACH.MAX_CONCURRENCY`, 'INVALID_FOREACH_CONCURRENCY', 'FOREACH MAX_CONCURRENCY must be a positive integer.');
            }
        }
    }
}

function validateWorkflowReferences(rawSteps: unknown[], stepIds: ReadonlySet<string>, errors: ValidationIssue[]): void {
    rawSteps.forEach((rawStep, index) => {
        if (!isRecord(rawStep)) return;
        const dependencies = new Set(
            Array.isArray(rawStep.DEPENDS_ON)
                ? rawStep.DEPENDS_ON.filter((item): item is string => typeof item === 'string').map(item => item.trim())
                : []
        );
        const references: Array<{ path: string; value: unknown }> = [
            { path: `STEPS[${index}].WHEN.PATH`, value: isRecord(rawStep.WHEN) ? rawStep.WHEN.PATH : undefined },
            { path: `STEPS[${index}].FOREACH.ITEMS`, value: isRecord(rawStep.FOREACH) ? rawStep.FOREACH.ITEMS : undefined }
        ];
        for (const reference of references) {
            if (typeof reference.value !== 'string' || !isValidWorkflowPath(reference.value)) continue;
            const root = getWorkflowPathRoot(reference.value);
            if (root === 'input') continue;
            if (root === undefined || RESERVED_CONTEXT_ROOTS.has(root)) {
                addIssue(errors, reference.path, 'INVALID_WORKFLOW_ROOT', `Workflow path root "${root ?? ''}" is not available here.`);
            } else if (!stepIds.has(root)) {
                addIssue(errors, reference.path, 'MISSING_WORKFLOW_SOURCE', `Workflow source step "${root}" does not exist.`);
            } else if (!dependencies.has(root)) {
                addIssue(errors, reference.path, 'WORKFLOW_SOURCE_NOT_DEPENDENCY', `Step "${root}" must be declared in DEPENDS_ON before its output can be used.`);
            }
        }
    });
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
            validateCodeParameters(params, paramsPath, errors);
            break;
        case 'PYTHON':
            validateCodeParameters(params, paramsPath, errors);
            validateEnvironment(params.ENV, paramsPath + '.ENV', errors);
            break;
      }

    const plugin = ExecutorRegistry.getPlugin(step.TYPE);
    if (plugin?.validate !== undefined) {
        try {
            errors.push(...plugin.validate(params, paramsPath));
        } catch (error: unknown) {
            addIssue(errors, paramsPath, 'PLUGIN_VALIDATION_FAILED', error instanceof Error ? error.message : String(error));
        }
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
    if (params.TIMEOUT_MS !== undefined &&
        (typeof params.TIMEOUT_MS !== 'number' || !Number.isInteger(params.TIMEOUT_MS) || params.TIMEOUT_MS < 1)
    ) {
        addIssue(errors, `${path}.TIMEOUT_MS`, 'INVALID_TIMEOUT', 'TIMEOUT_MS must be a positive integer.');
    }
}

function validateEnvironment(value: unknown, path: string, errors: ValidationIssue[]): void {
    if (value === undefined) return;
    if (!isRecord(value)) {
        addIssue(errors, path, 'INVALID_ENV', 'ENV must be an object.');
        return;
    }
    for (const [name, item] of Object.entries(value)) {
        if (typeof item !== 'string') {
            addIssue(errors, path + '.' + name, 'INVALID_ENV_VALUE', 'Environment variable values must be strings.');
        }
    }
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
