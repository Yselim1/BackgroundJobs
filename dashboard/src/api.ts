import type {
    AttentionFilters,
    AttentionItem,
    AuditEvent,
    AuditFilters,
    AuthSession,
    ExecutionDetail,
    ExecutionPage,
    ExecutionFilters,
    ExecutionStatus,
    ExecutionSummary,
    Job,
    JobDefinition,
    JobPlan,
    JobRevision,
    JobRevisionSummary,
    RoleSummary,
    ManagedSecret,
    PageResponse,
    PlatformOverview,
    SecurityRole,
    SecurityUser,
    SecretUsage,
    SystemStatus,
    UserAccessSummary,
    ValidationIssue,
    WebhookDelivery
    ,WorkerInstance, QueueSummary, AutomationTrigger, AutomationTriggerEvent
} from './types';

const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/u, '') ?? '';
export const AUTH_EXPIRED_EVENT = 'workline:auth-expired';

export async function getOverview(): Promise<PlatformOverview> {
    return request('/api/platform/overview');
}

export async function getCurrentUser(): Promise<AuthSession> {
    return request('/api/auth/me');
}

export async function login(email: string, password: string): Promise<AuthSession> {
    return request('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
    });
}

export async function logout(): Promise<void> {
    await request('/api/auth/logout', { method: 'POST' });
}

export async function changeOwnPassword(currentPassword: string, newPassword: string): Promise<void> {
    await request('/api/auth/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword })
    });
}

export async function getSecurityUsers(): Promise<SecurityUser[]> {
    const result = await request<{ items: SecurityUser[] }>('/api/security/users');
    return result.items;
}

export async function getSecurityRoles(): Promise<RoleSummary[]> {
    const result = await request<{ items: RoleSummary[] }>('/api/security/roles');
    return result.items;
}

export async function createSecurityUser(input: {
    email: string;
    displayName: string;
    password: string;
    role: SecurityRole;
}): Promise<SecurityUser> {
    return request('/api/security/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input)
    });
}

export async function updateSecurityUser(
    userId: string,
    input: { role?: SecurityRole; status?: 'active' | 'disabled'; displayName?: string }
): Promise<SecurityUser> {
    return request('/api/security/users/' + encodeURIComponent(userId), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input)
    });
}

export async function resetSecurityUserPassword(userId: string, password: string): Promise<void> {
    await request('/api/security/users/' + encodeURIComponent(userId) + '/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password })
    });
}

export async function getSecurityUserAccess(userId: string): Promise<UserAccessSummary> {
    return request('/api/security/users/' + encodeURIComponent(userId) + '/access');
}

export async function unlockSecurityUser(userId: string): Promise<SecurityUser> {
    return request('/api/security/users/' + encodeURIComponent(userId) + '/unlock', { method: 'POST' });
}

export async function revokeSecurityUserAccess(userId: string): Promise<{ sessionsRevoked: number; tokensRevoked: number }> {
    return request('/api/security/users/' + encodeURIComponent(userId) + '/revoke-access', { method: 'POST' });
}

export async function revokeSecurityUserSession(userId: string, sessionId: string): Promise<void> {
    await request('/api/security/users/' + encodeURIComponent(userId) + '/sessions/' + encodeURIComponent(sessionId), { method: 'DELETE' });
}

export async function revokeSecurityUserToken(userId: string, tokenId: string): Promise<void> {
    await request('/api/security/users/' + encodeURIComponent(userId) + '/tokens/' + encodeURIComponent(tokenId), { method: 'DELETE' });
}

export async function getManagedSecrets(): Promise<{ configured: boolean; items: ManagedSecret[] }> {
    return request('/api/security/secrets');
}

export async function putManagedSecret(
    name: string,
    value: string,
    description: string,
    ownerUserId: string | null,
    expiresOn: string | null
): Promise<ManagedSecret> {
    return request('/api/security/secrets/' + encodeURIComponent(name), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value, description, ownerUserId, expiresOn })
    });
}

export async function getManagedSecretUsage(name: string): Promise<SecretUsage[]> {
    const result = await request<{ items: SecretUsage[] }>('/api/security/secrets/' + encodeURIComponent(name) + '/usage');
    return result.items;
}

export async function deleteManagedSecret(name: string, force = false): Promise<void> {
    await request('/api/security/secrets/' + encodeURIComponent(name) + (force ? '?force=true' : ''), { method: 'DELETE' });
}

export async function getSystemStatus(): Promise<SystemStatus> {
    return request('/api/security/system');
}

export async function getAttention(filters: AttentionFilters): Promise<PageResponse<AttentionItem>> {
    const query = new URLSearchParams({
        state: filters.state,
        page: String(filters.page),
        limit: String(filters.limit)
    });
    if (filters.kind !== undefined) query.set('kind', filters.kind);
    if (filters.search !== undefined) query.set('search', filters.search);
    if (filters.from !== undefined) query.set('from', filters.from);
    if (filters.to !== undefined) query.set('to', filters.to);
    return request('/api/attention?' + query.toString());
}

export async function getAttentionItem(attentionId: string): Promise<AttentionItem> {
    return request('/api/attention/' + encodeURIComponent(attentionId));
}

export async function ignoreAttention(attentionId: string): Promise<AttentionItem> {
    return mutateAttention(attentionId, 'ignore');
}

export async function restoreAttention(attentionId: string): Promise<AttentionItem> {
    return mutateAttention(attentionId, 'restore');
}

export async function rerunAttention(attentionId: string): Promise<AttentionItem> {
    return mutateAttention(attentionId, 'rerun');
}

export async function retryAttentionWebhook(attentionId: string): Promise<AttentionItem> {
    return mutateAttention(attentionId, 'retry-webhook');
}

function mutateAttention(attentionId: string, action: string): Promise<AttentionItem> {
    return request('/api/attention/' + encodeURIComponent(attentionId) + '/' + action, {
        method: 'POST'
    });
}

export async function getAuditEvents(filters: AuditFilters & { page: number }): Promise<PageResponse<AuditEvent>> {
    const query = auditQuery(filters);
    query.set('page', String(filters.page));
    query.set('limit', String(filters.limit ?? 25));
    return request('/api/security/audit?' + query.toString());
}

export async function getAuditEvent(auditId: string): Promise<AuditEvent> {
    return request('/api/security/audit/' + encodeURIComponent(auditId));
}

export async function downloadAuditExport(
    filters: AuditFilters,
    format: 'csv' | 'json'
): Promise<{ blob: Blob; filename: string; total: number; exported: number; truncated: boolean }> {
    const query = auditQuery(filters);
    query.set('format', format);
    const response = await send('/api/security/audit/export?' + query.toString());
    if (!response.ok) throw await apiError(response, '/api/security/audit/export');
    const disposition = response.headers.get('Content-Disposition') ?? '';
    const filename = disposition.split('filename=').at(-1)?.trim() || ('audit.' + format);
    return {
        blob: await response.blob(),
        filename,
        total: Number(response.headers.get('X-Audit-Export-Total') ?? 0),
        exported: Number(response.headers.get('X-Audit-Export-Count') ?? 0),
        truncated: response.headers.get('X-Audit-Export-Truncated') === 'true'
    };
}

export async function getJobs(): Promise<Job[]> {
    return request('/api/jobs');
}

export async function getJob(jobId: string): Promise<Job> {
    return request('/api/jobs/' + encodeURIComponent(jobId));
}

export async function getJobPlan(jobId: string): Promise<JobPlan> {
    return request('/api/jobs/' + encodeURIComponent(jobId) + '/plan');
}

export async function validateJob(
    definition: JobDefinition
): Promise<{ valid: true; errors: []; job: JobDefinition } | { valid: false; errors: ValidationIssue[] }> {
    return request('/api/jobs/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(definition)
    });
}

export async function createJob(definition: JobDefinition): Promise<Job> {
    return request('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(definition)
    });
}

export async function replaceJob(jobId: string, definition: JobDefinition, version: number): Promise<Job> {
    return request('/api/jobs/' + encodeURIComponent(jobId), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'If-Match': `"${version}"` },
        body: JSON.stringify(definition)
    });
}

export function getJobVersions(jobId: string, page = 1, limit = 25): Promise<PageResponse<JobRevisionSummary>> {
    return request(`/api/jobs/${encodeURIComponent(jobId)}/versions?page=${page}&limit=${limit}`);
}
export function getJobVersion(jobId: string, version: number): Promise<JobRevision> {
    return request(`/api/jobs/${encodeURIComponent(jobId)}/versions/${version}`);
}
export function rollbackJob(jobId: string, targetVersion: number, expectedVersion: number): Promise<Job> {
    return request(`/api/jobs/${encodeURIComponent(jobId)}/rollback`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targetVersion, expectedVersion }) });
}
export async function getWorkers(): Promise<WorkerInstance[]> { return (await request<{ items: WorkerInstance[] }>('/api/workers')).items; }
export async function getQueues(): Promise<QueueSummary[]> { return (await request<{ items: QueueSummary[] }>('/api/queues')).items; }
export function drainWorker(workerId: string): Promise<WorkerInstance> { return request(`/api/workers/${encodeURIComponent(workerId)}/drain`, { method: 'POST' }); }
export function resumeWorker(workerId: string): Promise<WorkerInstance> { return request(`/api/workers/${encodeURIComponent(workerId)}/resume`, { method: 'POST' }); }
export async function getAutomationTriggers(jobId: string): Promise<AutomationTrigger[]> { return (await request<{ items: AutomationTrigger[] }>(`/api/jobs/${encodeURIComponent(jobId)}/triggers`)).items; }
export function createWebhookTrigger(jobId: string, name: string): Promise<{ trigger: AutomationTrigger; token: string }> { return request(`/api/jobs/${encodeURIComponent(jobId)}/triggers`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'webhook', name }) }); }
export function createChainTrigger(jobId: string, name: string, sourceJobId: string, terminalStatuses: string[]): Promise<AutomationTrigger> { return request(`/api/jobs/${encodeURIComponent(jobId)}/triggers`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'job_completion', name, sourceJobId, terminalStatuses }) }); }
export function updateAutomationTrigger(jobId: string, triggerId: string, input: { name?: string; enabled?: boolean; terminalStatuses?: string[] }): Promise<AutomationTrigger> { return request(`/api/jobs/${encodeURIComponent(jobId)}/triggers/${encodeURIComponent(triggerId)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }); }
export function rotateAutomationToken(jobId: string, triggerId: string): Promise<{ trigger: AutomationTrigger; token: string }> { return request(`/api/jobs/${encodeURIComponent(jobId)}/triggers/${encodeURIComponent(triggerId)}/rotate-token`, { method: 'POST' }); }
export async function deleteAutomationTrigger(jobId: string, triggerId: string): Promise<void> { await request(`/api/jobs/${encodeURIComponent(jobId)}/triggers/${encodeURIComponent(triggerId)}`, { method: 'DELETE' }); }
export function getAutomationEvents(jobId: string, page = 1): Promise<PageResponse<AutomationTriggerEvent>> { return request(`/api/jobs/${encodeURIComponent(jobId)}/trigger-events?page=${page}&limit=25`); }

export async function bulkSetJobStatus(
    jobIds: string[],
    status: 'active' | 'inactive'
): Promise<Job[]> {
    const result = await request<{ items: Job[] }>('/api/jobs/bulk-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobIds, status })
    });
    return result.items;
}

export async function previewSchedule(
    schedule: string,
    timezone: string,
    count = 5
): Promise<{ schedule: string; timezone: string; generatedAt: string; occurrences: string[] }> {
    return request('/api/jobs/schedule-preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schedule, timezone, count })
    });
}

export async function getExecutors(): Promise<string[]> {
    const result = await request<{ items: string[] }>('/api/platform/executors');
    return result.items;
}

export async function getExecutions(
    filters: ExecutionFilters & { page: number }
): Promise<PageResponse<ExecutionSummary>>;
export async function getExecutions(filters?: ExecutionFilters): Promise<ExecutionPage>;
export async function getExecutions(
    filters: ExecutionFilters = {}
): Promise<ExecutionPage | PageResponse<ExecutionSummary>> {
    const query = new URLSearchParams({ limit: String(filters.limit ?? 30) });
    if (filters.jobId !== undefined) query.set('jobId', filters.jobId);
    if (filters.status !== undefined) query.set('status', filters.status);
    if (filters.trigger !== undefined) query.set('trigger', filters.trigger);
    if (filters.from !== undefined) query.set('from', filters.from);
    if (filters.to !== undefined) query.set('to', filters.to);
    if (filters.cursor !== undefined) query.set('cursor', filters.cursor);
    if (filters.page !== undefined) query.set('page', String(filters.page));
    if (filters.order !== undefined) query.set('order', filters.order);
    return request('/api/executions?' + query.toString());
}

export async function getExecution(executionId: string): Promise<ExecutionDetail> {
    return request('/api/executions/' + encodeURIComponent(executionId));
}

export async function getWebhookDeliveries(executionId: string): Promise<WebhookDelivery[]> {
    return request('/api/executions/' + encodeURIComponent(executionId) + '/webhooks');
}

export async function runJob(jobId: string): Promise<{ executionId: string }> {
    return request('/api/jobs/' + encodeURIComponent(jobId) + '/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: {} })
    });
}

export async function cancelExecution(executionId: string): Promise<void> {
    await request('/api/executions/' + encodeURIComponent(executionId) + '/cancel', { method: 'POST' });
}

export function executionEventUrl(executionId: string): string {
    return API_BASE + '/api/executions/' + encodeURIComponent(executionId) + '/events';
}

export function executionFeedUrl(): string {
    return API_BASE + '/api/executions/events';
}

function auditQuery(filters: AuditFilters): URLSearchParams {
    const query = new URLSearchParams();
    if (filters.action !== undefined) query.set('action', filters.action);
    if (filters.actorType !== undefined) query.set('actorType', filters.actorType);
    if (filters.actorLabel !== undefined) query.set('actorLabel', filters.actorLabel);
    if (filters.actorUserId !== undefined) query.set('actorUserId', filters.actorUserId);
    if (filters.resource !== undefined) query.set('resource', filters.resource);
    if (filters.resourceType !== undefined) query.set('resourceType', filters.resourceType);
    if (filters.resourceId !== undefined) query.set('resourceId', filters.resourceId);
    if (filters.outcome !== undefined) query.set('outcome', filters.outcome);
    if (filters.from !== undefined) query.set('from', filters.from);
    if (filters.to !== undefined) query.set('to', filters.to);
    return query;
}

async function send(path: string, init?: RequestInit): Promise<Response> {
    const headers = new Headers(init?.headers);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
        const csrfToken = readCookie('bj_csrf');
        if (csrfToken !== undefined) headers.set('X-CSRF-Token', csrfToken);
    }
    return fetch(API_BASE + path, {
        ...init,
        headers,
        credentials: 'include'
    });
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await send(path, init);
    if (!response.ok) {
        throw await apiError(response, path);
    }
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
}

async function apiError(response: Response, path: string): Promise<ApiError> {
    const payload = await response.json().catch(() => ({})) as {
        error?: string;
        code?: string;
        details?: unknown;
    };
    if (response.status === 401 && path !== '/api/auth/login') {
        window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT));
    }
    return new ApiError(
        payload.error ?? ('Request failed with HTTP ' + response.status),
        response.status,
        payload.code,
        payload.details
    );
}

export class ApiError extends Error {
    constructor(
        message: string,
        readonly status: number,
        readonly code?: string,
        readonly details?: unknown
    ) {
        super(message);
        this.name = 'ApiError';
    }
}

function readCookie(name: string): string | undefined {
    const prefix = name + '=';
    const value = document.cookie.split(';').map(item => item.trim()).find(item => item.startsWith(prefix));
    if (value === undefined) return undefined;
    try { return decodeURIComponent(value.slice(prefix.length)); }
    catch { return undefined; }
}
