import { describe, expect, it } from 'vitest';
import { parseAdminTab } from './AdminPage';

describe('Administration tabs', () => {
    it('defaults to Users and persists the requested tab', () => {
        expect(parseAdminTab('')).toBe('users');
        expect(parseAdminTab('?tab=secrets')).toBe('secrets');
        expect(parseAdminTab('?tab=invalid')).toBe('users');
    });

    it('falls back to a permitted tab', () => {
        expect(parseAdminTab('?tab=users', false, true)).toBe('secrets');
        expect(parseAdminTab('?tab=secrets', true, false)).toBe('users');
    });
});
