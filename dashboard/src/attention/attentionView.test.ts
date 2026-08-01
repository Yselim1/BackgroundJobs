import { describe, expect, it } from 'vitest';
import { availableAttentionActions, recoverAttentionPage } from './attentionView';

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
});
