import type { ExecutionDetail, ExecutionPage, ExecutionStatus, Job, PlatformOverview } from './types';

const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/u, '') ?? '';

export async function getOverview(): Promise<PlatformOverview> {
    return request('/api/platform/overview');
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
    const response = await fetch(API_BASE + path, init);
    if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(payload.error ?? ('Request failed with HTTP ' + response.status));
    }
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
}
