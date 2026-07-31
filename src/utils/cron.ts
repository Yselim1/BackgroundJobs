import { CronExpressionParser } from 'cron-parser';

export function assertValidTimezone(timezone: string): void {
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
    } catch {
        throw new Error(`Invalid IANA timezone: "${timezone}".`);
    }
}

export function assertValidCron(expression: string, timezone = 'UTC'): void {
    if (expression.trim().split(/\s+/u).length !== 6) {
        throw new Error('schedule must contain exactly six cron fields (seconds through day-of-week).');
    }
    assertValidTimezone(timezone);
    CronExpressionParser.parse(expression, { currentDate: new Date(), tz: timezone, strict: true });
}

export function nextOccurrence(expression: string, timezone: string, after: Date): Date {
    const interval = CronExpressionParser.parse(expression, {
        currentDate: after,
        tz: timezone,
        strict: true
    });
    return interval.next().toDate();
}

export function latestOccurrence(expression: string, timezone: string, atOrBefore: Date): Date {
    const inclusiveCursor = new Date(atOrBefore.getTime() + 1);
    const interval = CronExpressionParser.parse(expression, {
        currentDate: inclusiveCursor,
        tz: timezone,
        strict: true
    });
    return interval.prev().toDate();
}

export interface CoalescedOccurrence {
    scheduledFor: Date;
    nextRunAt: Date;
}

export function coalesceOccurrences(expression: string, timezone: string, now: Date): CoalescedOccurrence {
    return {
        scheduledFor: latestOccurrence(expression, timezone, now),
        nextRunAt: nextOccurrence(expression, timezone, now)
    };
}

