export type ExecutionStatus = 'queued' | 'running' | 'success' | 'failed' | 'cancelled' | 'skipped';
export type SecurityRole = 'viewer' | 'operator' | 'admin';

export interface AuthSession {
    user: {
        userId: string;
        email: string;
        displayName: string;
        role: SecurityRole;
    };
    authType: 'session' | 'api_token';
    passwordChangeRequired: boolean;
    permissions: string[];
}

export interface SecurityUser {
    userId: string;
    email: string;
    displayName: string;
    role: SecurityRole;
    status: 'active' | 'disabled';
    failedLoginAttempts: number;
    lockedUntil: string | null;
    passwordChangeRequired: boolean;
    lastLoginAt: string | null;
    passwordChangedAt: string;
    createdAt: string;
    updatedAt: string;
}

export interface RoleSummary {
    role: SecurityRole;
    permissions: string[];
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

export type AttentionKind = 'execution_failure' | 'webhook_failure';
export type AttentionState = 'open' | 'ignored' | 'resolved';

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
    stateChangedBy: { type: 'system' | 'user' | 'api_token'; userId: string | null; label: string } | null;
    stateChangedAt: string | null;
    resolutionAction: 'rerun' | 'webhook_retry' | null;
    resolutionDetails: Record<string, unknown> | null;
    createdAt: string;
    updatedAt: string;
}

export interface AttentionFilters {
    state: AttentionState;
    kind?: AttentionKind;
    search?: string;
    from?: string;
    to?: string;
    page: number;
    limit: 25 | 50 | 100;
}

export interface ManagedSecret {
    secretId: string;
    name: string;
    description: string | null;
    keyVersion: number;
    owner: { userId: string; displayName: string; email: string } | null;
    lastRotatedBy: { userId: string; displayName: string; email: string } | null;
    expiresOn: string | null;
    createdAt: string;
    updatedAt: string;
}

export interface SecretUsage {
    jobId: string;
    jobName: string;
    jobStatus: 'active' | 'inactive';
    references: Array<{
        kind: 'runtime_template' | 'webhook_signing';
        path: string;
    }>;
}

export interface SystemStatus {
    generatedAt: string;
    services: { executionManager: 'online' | 'offline'; webhookDispatcher: 'online' | 'offline' };
    database: { status: 'online'; latencyMs: number; schemaVersion: number; expectedSchemaVersion: number };
    workers: { concurrency: number; schedulerPollMs: number; shutdownGraceMs: number; databasePoolMax: number };
    webhooks: { concurrency: number; pollMs: number; maxAttempts: number; requestTimeoutMs: number; legacySigningKeyConfigured: boolean };
    authentication: { sessionTtlMs: number; sessionIdleMs: number; secureCookies: boolean; trustProxy: boolean };
    secrets: { configured: boolean };
    retention: { mode: 'manual'; dryRunCommand: string; confirmCommand: string };
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

export interface PageResponse<T> {
    items: T[];
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
}

export interface AuditFilters {
    action?: string;
    actorType?: AuditEvent['actorType'];
    actorLabel?: string;
    actorUserId?: string;
    resource?: string;
    resourceType?: string;
    resourceId?: string;
    outcome?: AuditEvent['outcome'];
    from?: string;
    to?: string;
    page?: number;
    limit?: number;
}

export interface PlatformOverview {
    generatedAt: string;
    jobs: { total: number; active: number; inactive: number };
    executions: {
        queued: number;
        running: number;
        success24h: number;
        failed24h: number;
        cancelled24h: number;
        skipped24h: number;
        successRate24h: number | null;
        averageQueueLatencyMs24h: number | null;
        oldestQueuedAgeMs: number | null;
        averageSuccessDurationMs24h: number | null;
    };
    webhooks: { pending: number; delivering: number; failed: number };
    workers: { capacity: number; busy: number; available: number; utilizationPercent: number };
    attention: {
        openExecutionFailures: number;
        openWebhookFailures: number;
        failedExecutions: AttentionItem[];
        failedWebhooks: AttentionItem[];
    };
}

export interface RetryPolicy {
    MAX_ATTEMPTS?: number;
    DELAY_MS?: number;
    BACKOFF?: 'fixed' | 'exponential';
}

export interface JobStep {
    ORDER: number;
    ID: string;
    NAME: string;
    TYPE: string;
    DEPENDS_ON?: string[];
    STEP_PARAMS: Record<string, unknown>;
    WHEN?: { PATH: string; OPERATOR?: string; VALUE?: unknown };
    FOREACH?: { ITEMS: string; MAX_CONCURRENCY?: number };
    RETRY?: RetryPolicy;
    FAIL_JOB_ON_FAILURE?: boolean;
    [key: string]: unknown;
}

export interface JobDefinition {
    id: string;
    name: string;
    status: 'active' | 'inactive';
    description?: string;
    schedule?: string;
    timezone: string;
    TIMEOUT_MS?: number;
    MAX_CONCURRENCY?: number;
    FAILURE_POLICY?: 'fail_fast' | 'continue_independent';
    DEFAULT_STEP_RETRY?: RetryPolicy;
    STEPS: JobStep[];
    [key: string]: unknown;
}

export interface Job extends JobDefinition {
    next_run: string | null;
    last_run: string | null;
    created_at?: string;
    updated_at?: string;
}

export interface ValidationIssue {
    path: string;
    code: string;
    message: string;
}

export interface ExecutionSummary {
    executionId: string;
    jobId: string;
    trigger: 'manual' | 'scheduled';
    status: ExecutionStatus;
    scheduledFor: string | null;
    requestedAt: string;
    requestedBy: { type: 'system' | 'user' | 'api_token'; userId: string | null; label: string };
    startedAt: string | null;
    finishedAt: string | null;
    cancelRequestedAt: string | null;
    cancelRequestedBy: { type: 'user' | 'api_token'; userId: string | null; label: string } | null;
    durationMs: number | null;
    error: { code: string | null; message: string } | null;
    skipReason: string | null;
}

export interface StepAttempt {
    attempt: number;
    itemIndex?: number;
    status: string;
    startedAt?: string;
    finishedAt?: string;
    durationMs?: number;
    errorCode?: string;
    error?: string;
}

export interface StepResult {
    stepId: string;
    stepName: string;
    stepType: string;
    status: string;
    durationMs?: number;
    attempts: StepAttempt[];
    output?: unknown;
    reason?: string;
    errorCode?: string;
    error?: string;
}

export interface ExecutionDetail extends ExecutionSummary {
    input: Record<string, unknown>;
    jobDefinition: JobDefinition;
    stepResults: Record<string, StepResult>;
}

export interface ExecutionPage {
    items: ExecutionSummary[];
    nextCursor: string | null;
}

export interface ExecutionFilters {
    jobId?: string;
    status?: ExecutionStatus;
    trigger?: 'manual' | 'scheduled';
    from?: string;
    to?: string;
    limit?: number;
    cursor?: string;
    page?: number;
    order?: 'asc' | 'desc';
}

export interface WebhookDelivery {
    deliveryId: string;
    executionId: string;
    eventType: string;
    url: string;
    status: 'pending' | 'delivering' | 'success' | 'failed';
    attemptCount: number;
    nextAttemptAt: string;
    responseStatus: number | null;
    lastError: string | null;
    createdAt: string;
    updatedAt: string;
    deliveredAt: string | null;
}

export interface JobPlan {
    jobId: string;
    maxConcurrency: number;
    failurePolicy: 'fail_fast' | 'continue_independent';
    levels: Array<{
        level: number;
        steps: Array<{
            id: string;
            name: string;
            type: string;
            order: number;
            dependsOn: string[];
            when?: unknown;
            foreach?: unknown;
        }>;
    }>;
}
