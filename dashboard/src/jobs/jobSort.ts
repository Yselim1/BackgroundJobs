import type { Job } from '../types';

export type JobSort = 'name' | 'created_at' | 'status' | 'last_run' | 'next_run' | 'steps';

export function sortJobs(jobs: Job[], sort: JobSort, direction: 'asc' | 'desc'): Job[] {
    const multiplier = direction === 'asc' ? 1 : -1;
    return [...jobs].sort((left, right) => {
        let comparison: number;
        if (sort === 'steps') {
            comparison = left.STEPS.length - right.STEPS.length;
        } else {
            const leftValue = sort === 'name' ? left.name : sort === 'status' ? left.status : left[sort] ?? '';
            const rightValue = sort === 'name' ? right.name : sort === 'status' ? right.status : right[sort] ?? '';
            comparison = String(leftValue).localeCompare(String(rightValue));
        }
        return comparison === 0 ? left.id.localeCompare(right.id) : comparison * multiplier;
    });
}
