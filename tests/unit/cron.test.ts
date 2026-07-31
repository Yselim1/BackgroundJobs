import { describe, expect, it } from 'vitest';
import { assertValidCron, assertValidTimezone, coalesceOccurrences, nextOccurrence } from '../../src/utils/cron.js';

describe('cron scheduling', () => {
    it('requires exactly six fields and valid IANA timezones', () => {
        expect(() => assertValidCron('*/5 * * * *', 'UTC')).toThrow(/six cron fields/i);
        expect(() => assertValidCron('0 */5 * * * *', 'UTC')).not.toThrow();
        expect(() => assertValidTimezone('Mars/Olympus_Mons')).toThrow(/Invalid IANA timezone/);
    });

    it('calculates DST-aware occurrences', () => {
        const next = nextOccurrence('0 30 2 * * *', 'America/New_York', new Date('2026-03-08T06:59:59.000Z'));
        expect(next.toISOString()).toBe('2026-03-08T07:30:00.000Z');
    });

    it('coalesces missed occurrences into the latest due time and one future time', () => {
        const result = coalesceOccurrences('0 * * * * *', 'UTC', new Date('2026-07-31T12:05:45.000Z'));
        expect(result.scheduledFor.toISOString()).toBe('2026-07-31T12:05:00.000Z');
        expect(result.nextRunAt.toISOString()).toBe('2026-07-31T12:06:00.000Z');
    });
});
