import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { calendarRangeToApi, localDayAfterIso, localDayStartIso } from './dateFilters';

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
});
