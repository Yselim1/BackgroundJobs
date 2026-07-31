import { describe, expect, it } from 'vitest';
import { formatDuration, titleCase } from './format';

describe('dashboard formatting', () => {
    it('formats execution durations across useful scales', () => {
        expect(formatDuration(null)).toBe('—');
        expect(formatDuration(820)).toBe('820 ms');
        expect(formatDuration(1_250)).toBe('1.3 s');
        expect(formatDuration(65_000)).toBe('1m 5s');
    });

    it('turns API enum values into readable labels', () => {
        expect(titleCase('continue_independent')).toBe('Continue Independent');
    });
});
