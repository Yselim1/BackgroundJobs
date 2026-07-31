export function formatDuration(milliseconds: number | null | undefined): string {
    if (milliseconds === null || milliseconds === undefined) return '—';
    if (milliseconds < 1_000) return milliseconds + ' ms';
    if (milliseconds < 60_000) return (milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 1 : 0) + ' s';
    const minutes = Math.floor(milliseconds / 60_000);
    const seconds = Math.round((milliseconds % 60_000) / 1_000);
    return minutes + 'm ' + seconds + 's';
}

export function formatRelativeTime(value: string | null): string {
    if (value === null) return 'Never';
    const difference = Date.now() - Date.parse(value);
    const absolute = Math.abs(difference);
    const suffix = difference >= 0 ? 'ago' : 'from now';
    if (absolute < 60_000) return 'just now';
    if (absolute < 3_600_000) return Math.floor(absolute / 60_000) + 'm ' + suffix;
    if (absolute < 86_400_000) return Math.floor(absolute / 3_600_000) + 'h ' + suffix;
    return Math.floor(absolute / 86_400_000) + 'd ' + suffix;
}

export function titleCase(value: string): string {
    return value.replaceAll('_', ' ').replace(/\b\w/gu, character => character.toUpperCase());
}
