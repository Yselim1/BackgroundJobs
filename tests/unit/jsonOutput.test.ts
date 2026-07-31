import { describe, expect, it } from 'vitest';
import { normalizeJsonOutput } from '../../src/utils/jsonOutput.js';

describe('persisted output normalization', () => {
    it('stores top-level undefined as SQL-compatible null', () => {
        expect(normalizeJsonOutput(undefined)).toBeNull();
    });

    it('rejects BigInt and circular values with a stable code', () => {
        expect(() => normalizeJsonOutput(1n)).toThrow(expect.objectContaining({ code: 'OUTPUT_NOT_SERIALIZABLE' }));
        const circular: Record<string, unknown> = {};
        circular.self = circular;
        expect(() => normalizeJsonOutput(circular)).toThrow(expect.objectContaining({ code: 'OUTPUT_NOT_SERIALIZABLE' }));
    });
});
