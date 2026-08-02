export function localDayStartIso(value: string): string {
    return localMidnight(value, 0).toISOString();
}

export function localDayAfterIso(value: string): string {
    return localMidnight(value, 1).toISOString();
}

export function calendarRangeToApi(
    from: string,
    to: string
): { from?: string; to?: string } {
    return {
        ...(from.length === 0 ? {} : { from: localDayStartIso(from) }),
        ...(to.length === 0 ? {} : { to: localDayAfterIso(to) })
    };
}

export function isoToLocalCalendarDate(value: string): string {
    const date = new Date(value);
    const pad = (part: number) => String(part).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export interface ExactTimestampRange { from: string; to: string }

const EXACT_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;

export function parseExactTimestampRange(from: string | null, to: string | null): ExactTimestampRange | undefined {
    if (from === null || to === null) return undefined;
    if (!EXACT_TIMESTAMP.test(from) || !EXACT_TIMESTAMP.test(to)) return undefined;
    const fromMs = Date.parse(from);
    const toMs = Date.parse(to);
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) return undefined;
    return { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() };
}

export function activityBucketRange(
    bucketAt: string,
    bucketMs: number,
    activityStartsAt: string,
    activityGeneratedAt: string
): ExactTimestampRange {
    const bucketStart = Date.parse(bucketAt);
    const rangeStart = Date.parse(activityStartsAt);
    const rangeEnd = Date.parse(activityGeneratedAt);
    const from = Math.max(bucketStart, rangeStart);
    const to = Math.min(bucketStart + bucketMs, rangeEnd);
    if (![bucketStart, rangeStart, rangeEnd].every(Number.isFinite) || bucketMs <= 0 || from >= to) {
        throw new Error('Activity bucket boundaries are invalid.');
    }
    return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
}

function localMidnight(value: string, dayOffset: number): Date {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
    if (match === null) throw new Error('Date filters must use YYYY-MM-DD.');
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(year, month - 1, day + dayOffset, 0, 0, 0, 0);
    if (dayOffset === 0 && (
        date.getFullYear() !== year
        || date.getMonth() !== month - 1
        || date.getDate() !== day
    )) {
        throw new Error('Date filter is not a valid calendar day.');
    }
    return date;
}
