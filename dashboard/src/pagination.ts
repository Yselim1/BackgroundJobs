export function paginationWindow(page: number, totalPages: number, size = 5): number[] {
    if (totalPages < 1) return [];
    const width = Math.max(1, Math.min(size, totalPages));
    const half = Math.floor(width / 2);
    const start = Math.max(1, Math.min(page - half, totalPages - width + 1));
    return Array.from({ length: width }, (_, index) => start + index);
}

export function positivePage(value: string | null, fallback = 1): number {
    if (value === null || !/^\d+$/u.test(value)) return fallback;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : fallback;
}

export function pageSize(value: string | null, fallback = 25): 25 | 50 | 100 {
    const parsed = Number(value);
    return parsed === 25 || parsed === 50 || parsed === 100 ? parsed : fallback as 25 | 50 | 100;
}
