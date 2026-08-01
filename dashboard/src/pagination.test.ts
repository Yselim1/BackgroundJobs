import { describe, expect, it } from 'vitest';
import { pageSize, paginationWindow, positivePage } from './pagination';

describe('pagination helpers', () => {
    it('keeps a centered numeric window inside page bounds', () => {
        expect(paginationWindow(1, 10)).toEqual([1, 2, 3, 4, 5]);
        expect(paginationWindow(6, 10)).toEqual([4, 5, 6, 7, 8]);
        expect(paginationWindow(10, 10)).toEqual([6, 7, 8, 9, 10]);
        expect(paginationWindow(1, 0)).toEqual([]);
    });

    it('normalizes URL page and size values', () => {
        expect(positivePage('3')).toBe(3);
        expect(positivePage('0')).toBe(1);
        expect(pageSize('50')).toBe(50);
        expect(pageSize('42')).toBe(25);
    });
});
