import { describe, expect, it } from 'vitest';
import type { Job } from '../types';
import { sortJobs } from './jobSort';

describe('job sorting', () => {
    it('sorts by creation date and uses job ID as a stable tie-breaker', () => {
        const jobs = [
            job('z-job', '2026-01-02T00:00:00.000Z'),
            job('b-job', '2026-01-01T00:00:00.000Z'),
            job('a-job', '2026-01-01T00:00:00.000Z')
        ];
        expect(sortJobs(jobs, 'created_at', 'asc').map(item => item.id)).toEqual(['a-job', 'b-job', 'z-job']);
        expect(sortJobs(jobs, 'created_at', 'desc').map(item => item.id)).toEqual(['z-job', 'a-job', 'b-job']);
    });

    it('keeps Name ascending as the default-compatible ordering', () => {
        const jobs = [job('second', '2026-01-01T00:00:00.000Z'), job('first', '2026-01-02T00:00:00.000Z')];
        jobs[0]!.name = 'Zulu';
        jobs[1]!.name = 'Alpha';
        expect(sortJobs(jobs, 'name', 'asc').map(item => item.id)).toEqual(['first', 'second']);
    });
});

function job(id: string, createdAt: string): Job {
    return {
        id,
        version: 1,
        name: id,
        status: 'inactive',
        timezone: 'UTC',
        STEPS: [],
        next_run: null,
        last_run: null,
        created_at: createdAt
    };
}
