import { describe, expect, it } from 'vitest';
import { configurationDisabledReason, secretLifecycleState } from './SecretAdmin';

describe('managed-secret administration states', () => {
    it('distinguishes loading, configuration, and request failures', () => {
        expect(configurationDisabledReason('loading')).toMatch(/Checking/u);
        expect(configurationDisabledReason('unconfigured')).toMatch(/SECRETS_MASTER_KEY/u);
        expect(configurationDisabledReason('error')).toMatch(/could not be loaded/u);
        expect(configurationDisabledReason('configured')).toBeUndefined();
    });

    it('classifies optional, current, due-soon, and overdue advisory dates', () => {
        const today = '2026-08-02';
        expect(secretLifecycleState(null, today)).toBe('none');
        expect(secretLifecycleState('2026-08-01', today)).toBe('overdue');
        expect(secretLifecycleState('2026-08-16', today)).toBe('due_soon');
        expect(secretLifecycleState('2026-08-17', today)).toBe('current');
    });
});
