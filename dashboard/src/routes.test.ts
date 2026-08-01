import { describe, expect, it } from 'vitest';
import { parseDashboardRoute } from './routes';

describe('dashboard routes', () => {
    it('parses job and execution deep links', () => {
        expect(parseDashboardRoute('/jobs/nightly%20report')).toEqual({ page: 'job-detail', jobId: 'nightly report' });
        expect(parseDashboardRoute('/logs/exec-1')).toEqual({ page: 'logs', executionId: 'exec-1' });
    });

    it('falls back to overview', () => {
        expect(parseDashboardRoute('/unknown')).toEqual({ page: 'overview' });
    });
});
