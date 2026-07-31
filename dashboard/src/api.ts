import type {
    AuditEvent,
    AuthSession,
    ExecutionDetail,
    ExecutionPage,
    ExecutionStatus,
    Job,
    ManagedSecret,
    PlatformOverview,
    SecurityRole,
    SecurityUser
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

export async function getSecurityUsers(): Promise<SecurityUser[]> {
    const result = await request<{ items: SecurityUser[] }>('/api/security/users');
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

export async function getManagedSecrets(): Promise<{ configured: boolean; items: ManagedSecret[] }> {
    return request('/api/security/secrets');
}

export async function putManagedSecret(name: string, value: string, description: string): Promise<ManagedSecret> {
    return request('/api/security/secrets/' + encodeURIComponent(name), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value, description })
    });
}

export async function deleteManagedSecret(name: string): Promise<void> {
    await request('/api/security/secrets/' + encodeURIComponent(name), { method: 'DELETE' });
}

export async function getAuditEvents(): Promise<AuditEvent[]> {
    const result = await request<{ items: AuditEvent[] }>('/api/security/audit?limit=30');
    return result.items;
}

export async function getJobs(): Promise<Job[]> {
    return request('/api/jobs');
}

export async function getExecutions(status?: ExecutionStatus): Promise<ExecutionPage> {
    const query = new URLSearchParams({ limit: '30' });
    if (status !== undefined) query.set('status', status);
    return request('/api/executions?' + query.toString());
}

export async function getExecution(executionId: string): Promise<ExecutionDetail> {
    return request('/api/executions/' + encodeURIComponent(executionId));
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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const headers = new Headers(init?.headers);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
        const csrfToken = readCookie('bj_csrf');
        if (csrfToken !== undefined) headers.set('X-CSRF-Token', csrfToken);
    }
    const response = await fetch(API_BASE + path, {
        ...init,
        headers,
        credentials: 'include'
    });
    if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { error?: string; code?: string };
        if (response.status === 401 && path !== '/api/auth/login') {
            window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT));
        }
        throw new ApiError(
            payload.error ?? ('Request failed with HTTP ' + response.status),
            response.status,
            payload.code
        );
    }
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
}

export class ApiError extends Error {
    constructor(message: string, readonly status: number, readonly code?: string) {
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
