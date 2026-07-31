export type FailurePolicy = 'fail_fast' | 'continue_independent';
export type RetryBackoff = 'fixed' | 'exponential';
export interface RetryPolicy { MAX_ATTEMPTS?: number; DELAY_MS?: number; BACKOFF?: RetryBackoff; }
export interface StepParams { [key: string]: unknown; }
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';
export type RestApiResponseType = 'auto' | 'json' | 'text';
export type RestApiQueryPrimitive = string | number | boolean | null;
export type RestApiQueryValue = RestApiQueryPrimitive | RestApiQueryPrimitive[];
export interface RestApiStepParams extends StepParams { URL: string; METHOD?: HttpMethod; HEADERS?: Record<string, string>; QUERY?: Record<string, RestApiQueryValue>; BODY?: unknown; TIMEOUT_MS?: number; RESPONSE_TYPE?: RestApiResponseType; CAPTURE_RESPONSE_HEADERS?: string[]; }
export interface RestApiStepOutput { status: number; statusText: string; headers?: Record<string, string>; data: unknown; }
export interface Step { ORDER: number; ID: string; NAME: string; TYPE: string; DEPENDS_ON?: string[]; RETRY?: RetryPolicy; FAIL_JOB_ON_FAILURE?: boolean; STEP_PARAMS?: StepParams; }
export type StepStatus = 'pending' | 'running' | 'success' | 'failed' | 'skipped' | 'cancelled';
export type StepAttemptStatus = 'running' | 'success' | 'failed' | 'cancelled';
export interface StepAttemptLog { attempt: number; status: StepAttemptStatus; startedAt: string; finishedAt?: string; durationMs?: number; errorCode?: string; error?: string; }
export interface StepLog { stepId: string; stepName: string; stepType: string; status: StepStatus; startedAt?: string; finishedAt?: string; durationMs?: number; attempts: StepAttemptLog[]; output?: unknown; errorCode?: string; error?: string; reason?: string; }
export type JobStatus = 'active' | 'inactive';
export interface Job { id: string; name: string; schedule?: string; timezone: string; STEPS: Step[]; status: JobStatus; FAILURE_POLICY?: FailurePolicy; DEFAULT_STEP_RETRY?: RetryPolicy; MAX_CONCURRENCY?: number; TIMEOUT_MS?: number; [key: string]: unknown; }
export interface JobView extends Job { last_run: string | null; next_run: string | null; created_at: string; updated_at: string; }
export interface JobExecutionPlanStep { id: string; name: string; type: string; order: number; dependsOn: string[]; }
export interface JobExecutionPlanLevel { level: number; steps: JobExecutionPlanStep[]; }
export interface JobExecutionPlan { jobId: string; maxConcurrency: number; failurePolicy: FailurePolicy; levels: JobExecutionPlanLevel[]; }
export interface ValidationIssue { path: string; code: string; message: string; }
export type JobValidationResult = { valid: true; errors: []; job: Job } | { valid: false; errors: ValidationIssue[] };
export type ExecutionTrigger = 'manual' | 'scheduled';
export type ExecutionStatus = 'queued' | 'running' | 'success' | 'failed' | 'cancelled' | 'skipped';
export interface ExecutionSummary { executionId: string; logId: string; jobId: string; trigger: ExecutionTrigger; status: ExecutionStatus; scheduledFor: string | null; requestedAt: string; startedAt: string | null; finishedAt: string | null; cancelRequestedAt: string | null; durationMs: number | null; error: { code: string | null; message: string } | null; skipReason: string | null; }
export interface ExecutionDetail extends ExecutionSummary { jobDefinition: Job; stepResults: Record<string, StepLog>; }
export interface ExecutionListPage { items: ExecutionSummary[]; nextCursor: string | null; }
export interface JobRunResult { status: 'success' | 'failed' | 'cancelled'; errorCode?: string; error?: string; stepResults: Record<string, StepLog>; }
export interface JobLog { logId: string; jobId: string; startTime: string; endTime?: string; durationMs?: number; status: ExecutionStatus; stepResults: Record<string, StepLog>; error?: string; }
