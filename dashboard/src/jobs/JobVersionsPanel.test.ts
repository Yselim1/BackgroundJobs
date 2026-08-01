import { describe, expect, it } from 'vitest';
import { diffJson } from './JobVersionsPanel';

describe('job version diff', () => {
    it('marks added and removed definition lines while retaining context', () => {
        const lines = diffJson({ name: 'Before', enabled: true }, { name: 'After', enabled: true, queue: 'email' });
        expect(lines.some(line => line.kind === 'remove' && line.text.includes('Before'))).toBe(true);
        expect(lines.some(line => line.kind === 'add' && line.text.includes('After'))).toBe(true);
        expect(lines.some(line => line.kind === 'add' && line.text.includes('queue'))).toBe(true);
        expect(lines.some(line => line.kind === 'same' && line.text === '{')).toBe(true);
    });
});
