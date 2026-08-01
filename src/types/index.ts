export type FailurePolicy = 'fail_fast' | 'continue_independent';
export type RetryBackoff = 'fixed' | 'exponential';
export interface RetryPolicy { MAX_ATTEMPTS?: number; DELAY_MS?: number; BACKOFF?: RetryBackoff; }
export type WorkflowConditionOperator = 'equals' | 'not_equals' | 'exists' | 'not_exists' | 'truthy' | 'falsy' | 'greater_than' | 'greater_than_or_equal' | 'less_than' | 'less_than_or_equal' | 'contains';
export interface WorkflowCondition { PATH: string; OPERATOR?: WorkflowConditionOperator; VALUE?: unknown; }
export interface FanOutDefinition { ITEMS: string; MAX_CONCURRENCY?: number; }
export interface StepParams { [key: string]: unknown; }
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';
export type RestApiResponseType = 'auto' | 'json' | 'text';
export type RestApiQueryPrimitive = string | number | boolean | null;
export type RestApiQueryValue = RestApiQueryPrimitive | RestApiQueryPrimitive[];
export interface RestApiStepParams extends StepParams { URL: string; METHOD?: HttpMethod; HEADERS?: Record<string, string>; QUERY?: Record<string, RestApiQueryValue>; BODY?: unknown; TIMEOUT_MS?: number; RESPONSE_TYPE?: RestApiResponseType; CAPTURE_RESPONSE_HEADERS?: string[]; }
export interface RestApiStepOutput { status: number; statusText: string; headers?: Record<string, string>; data: unknown; }
export interface Step { ORDER: number; ID: string; NAME: string; TYPE: string; DEPENDS_ON?: string[]; WHEN?: WorkflowCondition; FOREACH?: FanOutDefinition; RETRY?: RetryPolicy; FAIL_JOB_ON_FAILURE?: boolean; STEP_PARAMS?: StepParams; }
export type StepStatus = 'pending' | 'running' | 'success' | 'failed' | 'skipped' | 'cancelled';
export type StepAttemptStatus = 'running' | 'success' | 'failed' | 'cancelled';
export interface StepAttemptLog { attempt: number; itemIndex?: number; status: StepAttemptStatus; startedAt: string; finishedAt?: string; durationMs?: number; errorCode?: string; error?: string; }
export interface StepLog { stepId: string; stepName: string; stepType: string; status: StepStatus; startedAt?: string; finishedAt?: string; durationMs?: number; attempts: StepAttemptLog[]; output?: unknown; errorCode?: string; error?: string; reason?: string; }
export type JobStatus = 'active' | 'inactive';
export type WebhookEventStatus = 'success' | 'failed' | 'cancelled' | 'skipped';
export interface JobWebhook { URL: string; EVENTS?: WebhookEventStatus[]; SIGNING_SECRET?: string; }
export interface Job { id: string; name: string; schedule?: string; timezone: string; STEPS: Step[]; status: JobStatus; FAILURE_POLICY?: FailurePolicy; DEFAULT_STEP_RETRY?: RetryPolicy; MAX_CONCURRENCY?: number; TIMEOUT_MS?: number; WEBHOOKS?: JobWebhook[]; [key: string]: unknown; }
export interface JobView extends Job { last_run: string | null; next_run: string | null; created_at: string; updated_at: string; }
export interface JobExecutionPlanStep { id: string; name: string; type: string; order: number; dependsOn: string[]; when?: WorkflowCondition; foreach?: FanOutDefinition; }
export interface JobExecutionPlanLevel { level: number; steps: JobExecutionPlanStep[]; }
export interface JobExecutionPlan { jobId: string; maxConcurrency: number; failurePolicy: FailurePolicy; levels: JobExecutionPlanLevel[]; }
export interface ValidationIssue { path: string; code: string; message: string; }
export type JobValidationResult = { valid: true; errors: []; job: Job } | { valid: false; errors: ValidationIssue[] };
export type ExecutionTrigger = 'manual' | 'scheduled';
export type ExecutionStatus = 'queued' | 'running' | 'success' | 'failed' | 'cancelled' | 'skipped';
export type SecurityRole = 'viewer' | 'operator' | 'admin';
export type SecurityUserStatus = 'active' | 'disabled';
export type AuthenticationType = 'session' | 'api_token';
export interface AuthenticatedActor {
    userId: string;
    email: string;
    displayName: string;
    role: SecurityRole;
    authType: AuthenticationType;
    credentialId: string;
    passwordChangeRequired: boolean;
}
export interface ActorSummary { type: 'system' | 'user' | 'api_token'; userId: string | null; label: string; }
export interface SecurityUser {
    userId: string;
    email: string;
    displayName: string;
    role: SecurityRole;
    status: SecurityUserStatus;
    failedLoginAttempts: number;
    lockedUntil: string | null;
    passwordChangeRequired: boolean;
    lastLoginAt: string | null;
    passwordChangedAt: string;
    createdAt: string;
    updatedAt: string;
}
export interface AdminSessionSummary {
    sessionId: string;
    expiresAt: string;
    idleExpiresAt: string;
    lastSeenAt: string;
    ipAddress: string | null;
    userAgent: string | null;
    createdAt: string;
}
export interface ApiTokenSummary {
    tokenId: string;
    name: string;
    expiresAt: string | null;
    lastUsedAt: string | null;
    revokedAt: string | null;
    createdAt: string;
}
export interface UserAccessSummary {
    sessions: AdminSessionSummary[];
    tokens: ApiTokenSummary[];
}
export interface ManagedSecretUserSummary {
    userId: string;
    displayName: string;
    email: string;
}
export interface ManagedSecretMetadata {
    secretId: string;
    name: string;
    description: string | null;
    keyVersion: number;
    owner: ManagedSecretUserSummary | null;
    lastRotatedBy: ManagedSecretUserSummary | null;
    expiresOn: string | null;
    createdAt: string;
    updatedAt: string;
}
export interface SecretUsageReference {
    kind: 'runtime_template' | 'webhook_signing';
    path: string;
}
export interface SecretUsage {
    jobId: string;
    jobName: string;
    jobStatus: JobStatus;
    references: SecretUsageReference[];
}
export interface AuditEvent {
    auditId: string;
    requestId: string;
    actorType: 'anonymous' | 'user' | 'api_token' | 'system';
    actorUserId: string | null;
    actorLabel: string;
    action: string;
    outcome: 'success' | 'failure';
    statusCode: number;
    resourceType: string | null;
    resourceId: string | null;
    ipAddress: string | null;
    userAgent: string | null;
    metadata: Record<string, unknown>;
    createdAt: string;
}
export interface PageResponse<T> { items: T[]; page: number; pageSize: number; total: number; totalPages: number; }
export type AttentionKind = 'execution_failure' | 'webhook_failure';
export type AttentionState = 'open' | 'ignored' | 'resolved';
export type AttentionResolutionAction = 'rerun' | 'webhook_retry';
export interface AttentionItem {
    attentionId: string;
    kind: AttentionKind;
    sourceId: string;
    executionId: string;
    jobId: string;
    reason: string;
    detailSnapshot: Record<string, unknown>;
    occurredAt: string;
    state: AttentionState;
    stateChangedBy: ActorSummary | null;
    stateChangedAt: string | null;
    resolutionAction: AttentionResolutionAction | null;
    resolutionDetails: Record<string, unknown> | null;
    createdAt: string;
    updatedAt: string;
}
export interface ExecutionSummary { executionId: string; logId: string; jobId: string; trigger: ExecutionTrigger; status: ExecutionStatus; scheduledFor: string | null; requestedAt: string; requestedBy: ActorSummary; startedAt: string | null; finishedAt: string | null; cancelRequestedAt: string | null; cancelRequestedBy: ActorSummary | null; durationMs: number | null; error: { code: string | null; message: string } | null; skipReason: string | null; }
export interface ExecutionDetail extends ExecutionSummary { input: Record<string, unknown>; jobDefinition: Job; stepResults: Record<string, StepLog>; }
export interface ExecutionListPage { items: ExecutionSummary[]; nextCursor: string | null; }
export interface ExecutionEvent { eventId: string; executionId: string; type: string; payload: Record<string, unknown>; createdAt: string; }
export type WebhookDeliveryStatus = 'pending' | 'delivering' | 'success' | 'failed';
export interface WebhookDeliverySummary { deliveryId: string; executionId: string; eventType: string; url: string; status: WebhookDeliveryStatus; attemptCount: number; nextAttemptAt: string; responseStatus: number | null; lastError: string | null; createdAt: string; updatedAt: string; deliveredAt: string | null; }
export interface JobRunResult { status: 'success' | 'failed' | 'cancelled'; errorCode?: string; error?: string; stepResults: Record<string, StepLog>; }
export interface JobLog { logId: string; jobId: string; startTime: string; endTime?: string; durationMs?: number; status: ExecutionStatus; stepResults: Record<string, StepLog>; error?: string; }
