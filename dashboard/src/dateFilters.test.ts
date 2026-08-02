import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { activityBucketRange, calendarRangeToApi, isoToLocalCalendarDate, localDayAfterIso, localDayStartIso, parseExactTimestampRange } from './dateFilters';

const originalTimezone = process.env.TZ;

describe.sequential('calendar date filters', () => {
    beforeAll(() => { process.env.TZ = 'America/New_York'; });
    afterAll(() => {
        if (originalTimezone === undefined) delete process.env.TZ;
        else process.env.TZ = originalTimezone;
    });

    it('uses local midnight and makes the selected end day inclusive', () => {
        expect(calendarRangeToApi('2026-02-10', '2026-02-12')).toEqual({
            from: localDayStartIso('2026-02-10'),
            to: localDayAfterIso('2026-02-12')
        });
    });

    it('constructs DST boundaries without assuming a day is 24 hours', () => {
        const springHours = (
            Date.parse(localDayAfterIso('2026-03-08')) - Date.parse(localDayStartIso('2026-03-08'))
        ) / 3_600_000;
        const autumnHours = (
            Date.parse(localDayAfterIso('2026-11-01')) - Date.parse(localDayStartIso('2026-11-01'))
        ) / 3_600_000;
        expect(springHours).toBe(23);
        expect(autumnHours).toBe(25);
    });

    it('converts activity timestamps to the local date-filter format', () => {
        expect(isoToLocalCalendarDate('2026-02-10T02:00:00.000Z')).toBe('2026-02-09');
    });

    it('clamps partial activity buckets to the exact generated window', () => {
        expect(activityBucketRange(
            '2026-02-10T10:00:00.000Z',
            60 * 60_000,
            '2026-02-10T10:15:00.000Z',
            '2026-02-10T11:45:00.000Z'
        )).toEqual({ from: '2026-02-10T10:15:00.000Z', to: '2026-02-10T11:00:00.000Z' });
        expect(activityBucketRange(
            '2026-02-10T11:00:00.000Z',
            60 * 60_000,
            '2026-02-10T10:15:00.000Z',
            '2026-02-10T11:45:00.000Z'
        )).toEqual({ from: '2026-02-10T11:00:00.000Z', to: '2026-02-10T11:45:00.000Z' });
    });

    it('accepts only ordered timestamp-level log ranges', () => {
        expect(parseExactTimestampRange('2026-02-10T10:00:00Z', '2026-02-10T11:00:00Z')).toEqual({
            from: '2026-02-10T10:00:00.000Z',
            to: '2026-02-10T11:00:00.000Z'
        });
        expect(parseExactTimestampRange('2026-02-10', '2026-02-11')).toBeUndefined();
        expect(parseExactTimestampRange('2026-02-10T11:00:00Z', '2026-02-10T10:00:00Z')).toBeUndefined();
    });
});
