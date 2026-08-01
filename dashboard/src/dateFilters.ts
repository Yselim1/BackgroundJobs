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
