import { describe, expect, it } from 'vitest';
import { dashboardNavigation } from './permissions';

describe('permission-aware navigation', () => {
    it('shows Attention to readers without exposing Administration or Audit', () => {
        expect(dashboardNavigation(['attention:read'])).toEqual({
            attention: true,
            administration: false,
            audit: false
        });
    });

    it('shows Administration for either management permission', () => {
        expect(dashboardNavigation(['secrets:manage']).administration).toBe(true);
        expect(dashboardNavigation(['users:manage', 'audit:read'])).toMatchObject({
            administration: true,
            audit: true
        });
    });
});
