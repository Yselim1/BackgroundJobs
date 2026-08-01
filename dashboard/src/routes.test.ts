import { describe, expect, it, vi } from 'vitest';
import { parseDashboardRoute, setRouteQuery } from './routes';

describe('dashboard routes', () => {
    it('parses job and execution deep links', () => {
        expect(parseDashboardRoute('/jobs/nightly%20report')).toEqual({ page: 'job-detail', jobId: 'nightly report' });
        expect(parseDashboardRoute('/logs/exec-1')).toEqual({ page: 'logs', executionId: 'exec-1' });
        expect(parseDashboardRoute('/audit')).toEqual({ page: 'audit' });
        expect(parseDashboardRoute('/attention')).toEqual({ page: 'attention' });
        expect(parseDashboardRoute('/workers')).toEqual({ page: 'workers' });
        expect(parseDashboardRoute('/admin')).toEqual({ page: 'admin' });
    });

    it('falls back to overview', () => {
        expect(parseDashboardRoute('/unknown')).toEqual({ page: 'overview' });
    });

    it('persists filters, page, and page size in the route query', () => {
        const replaceState = vi.fn();
        const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
        Object.defineProperty(globalThis, 'window', {
            configurable: true,
            value: { history: { replaceState } }
        });
        try {
            setRouteQuery('/logs', {
                status: 'failed',
                from: '2026-07-01',
                page: '3',
                pageSize: '50',
                trigger: 'all'
            });
            expect(replaceState).toHaveBeenCalledWith(
                null,
                '',
                '/logs?status=failed&from=2026-07-01&page=3&pageSize=50'
            );
        } finally {
            if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
            else Object.defineProperty(globalThis, 'window', originalWindow);
        }
    });
});
