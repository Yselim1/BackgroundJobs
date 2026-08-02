import { describe, expect, it } from 'vitest';
import { changedPaths, diffJson } from './JobVersionsPanel';

describe('job version diff', () => {
    it('marks added and removed definition lines while retaining context', () => {
        const lines = diffJson({ name: 'Before', enabled: true }, { name: 'After', enabled: true, queue: 'email' });
        expect(lines.some(line => line.kind === 'remove' && line.text.includes('Before'))).toBe(true);
        expect(lines.some(line => line.kind === 'add' && line.text.includes('After'))).toBe(true);
        expect(lines.some(line => line.kind === 'add' && line.text.includes('queue'))).toBe(true);
        expect(lines.some(line => line.kind === 'same' && line.text === '{')).toBe(true);
    });

    it('reports field-level changes for structured workflow comparison', () => {
        expect(changedPaths(
            { TYPE: 'SCRIPT', RETRY: { MAX_ATTEMPTS: 2 }, unchanged: true },
            { TYPE: 'RESTAPI', RETRY: { MAX_ATTEMPTS: 3 }, unchanged: true }
        )).toEqual(['TYPE', 'RETRY.MAX_ATTEMPTS']);
    });
});
