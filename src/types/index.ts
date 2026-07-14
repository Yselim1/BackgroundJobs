export type RetryBackoff = 'fixed' | 'exponential';

export interface RetryPolicy {
    COUNT?: number;
    DELAY_MS?: number;
    BACKOFF?: RetryBackoff;
}

export interface StepParams {
    [key: string]: any;
}

export interface Step {
    ORDER: number;
    ID: string;
    NAME: string;
    TYPE: string;
    DEPENDS_ON?: string[];
    RETRY?: RetryPolicy;
    STEP_PARAMS?: StepParams;
}

export interface Job {  
    id: string;
    name: string;
    schedule: string;
    STEPS?: Step[];
    command?: string;
    status: string;
    DEFAULT_RETRY?: RetryPolicy;
    MAX_CONCURRENCY?: number;
    [key: string]: any; 
}

export type StepAttemptStatus = 'success' | 'failed';

export interface StepAttemptLog {
    attempt: number;
    status: StepAttemptStatus;
    startedAt: string;
    finishedAt: string;
    durationMs: number;
    error?: string;
}


export type StepLogStatus = 'pending' | 'running' | 'success' | 'failed';

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