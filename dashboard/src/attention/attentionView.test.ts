import { describe, expect, it } from 'vitest';
import { availableAttentionActions, clampIncidentPreviewWidth, latestAttentionActivityAt, recoverAttentionPage } from './attentionView';

describe('attention view rules', () => {
    it('exposes state- and kind-compatible administrator actions', () => {
        expect(availableAttentionActions({ kind: 'execution_failure', state: 'open' }, true)).toEqual(['ignore', 'rerun']);
        expect(availableAttentionActions({ kind: 'webhook_failure', state: 'open' }, true)).toEqual(['ignore', 'retry']);
        expect(availableAttentionActions({ kind: 'webhook_failure', state: 'ignored' }, true)).toEqual(['restore']);
        expect(availableAttentionActions({ kind: 'execution_failure', state: 'resolved' }, true)).toEqual([]);
        expect(availableAttentionActions({ kind: 'execution_failure', state: 'open' }, false)).toEqual([]);
    });

    it('recovers an out-of-range page while preserving a valid page', () => {
        expect(recoverAttentionPage(9, 3)).toBe(3);
        expect(recoverAttentionPage(1, 0)).toBe(1);
        expect(recoverAttentionPage(2, 4)).toBe(2);
    });

    it('uses the most recent occurrence or incident update for latest activity', () => {
        expect(latestAttentionActivityAt({
            lastOccurredAt: '2026-08-02T10:00:00.000Z',
            updatedAt: '2026-08-02T10:20:00.000Z'
        })).toBe('2026-08-02T10:20:00.000Z');
    });

    it('keeps both sides of the incident split usable while resizing', () => {
        expect(clampIncidentPreviewWidth(1400, 420)).toBe(420);
        expect(clampIncidentPreviewWidth(1400, 100)).toBe(260);
        expect(clampIncidentPreviewWidth(1000, 600)).toBe(310);
    });
});
