export type FailurePolicy = 'fail_fast'| 'continue_independent';

export type RetryBackoff = 'fixed' | 'exponential';

export interface RetryPolicy {
    MAX_ATTEMPTS?: number;
    DELAY_MS?: number;
    BACKOFF?: RetryBackoff;
}

export interface StepParams {
    [key: string]: any;
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

export type RestApiResponseType = 'auto' | 'json' | 'text';

export type RestApiQueryPrimitive = string | number | boolean | null;

export type RestApiQueryValue = RestApiQueryPrimitive | RestApiQueryPrimitive[];

export interface RestApiStepParams extends StepParams {
    URL: string;
    METHOD?: HttpMethod;
    HEADERS?: Record<string, string>;
    QUERY?: Record<string, RestApiQueryValue>;
    BODY?: unknown;
    TIMEOUT_MS?: number;
    RESPONSE_TYPE?: RestApiResponseType;
    CAPTURE_RESPONSE_HEADERS?: string[];
}

export interface RestApiStepOutput {
    status: number;
    statusText: string;
    headers?: Record<string, string>;
    data: unknown;
}

export interface Step {
    ORDER: number;
    ID: string;
    NAME: string;
    TYPE: string;
    DEPENDS_ON?: string[];
    RETRY?: RetryPolicy;
    FAIL_JOB_ON_FAILURE?: boolean;
    STEP_PARAMS?: StepParams;
}

export type StepStatus = 'pending' | 'running' | 'success' | 'failed' | 'skipped' | 'cancelled';


export type StepResult = {
    stepId: string;
    stepName: string;
    stepType: string;
    status: StepStatus;

    attempts: StepAttemptLog[];

    startedAt?: string;
    finishedAt?: string;
    durationMs?: number;

    output?: unknown;
    error?: string;
    reason?: string;
};



export interface Job {  
    id: string;
    name: string;
    schedule: string;
    STEPS: Step[];
    status: string;
    FAILURE_POLICY?: FailurePolicy;
    DEFAULT_STEP_RETRY?: RetryPolicy;
    MAX_CONCURRENCY?: number;
    [key: string]: any; 
}

export type StepAttemptStatus = 'success' | 'failed' | 'skipped' | 'cancelled';

export interface StepAttemptLog {
    attempt: number;
    status: StepAttemptStatus;
    startedAt: string;
    finishedAt: string;
    durationMs: number;
    error?: string;
}


export type StepLogStatus = 'pending' | 'running' | 'success' | 'failed' | 'skipped' | 'cancelled';

export interface StepLog {
    stepId: string;
    stepName: string;
    stepType: string;
    status: StepLogStatus;
    startedAt?: string;
    finishedAt?: string;
    durationMs?: number;
    attempts?: StepAttemptLog[];
    output?: any;
    error?: string;
    reason?: string;
}

export interface JobLog {
    logId: string;
    jobId: string;
    startTime: string;
    endTime?: string;
    durationMs?: number;
    status: 'running' | 'success' | 'failed';
    stepResults: Record<string, StepLog>;
    error?: string;
}