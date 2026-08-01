import { describe, expect, it } from 'vitest';
import { attentionPath, parseAttentionFilters } from './attentionFilters';

describe('attention URL filters', () => {
    it('defaults invalid values to the open first page', () => {
        expect(parseAttentionFilters('?state=bad&page=0&limit=10&kind=bad')).toEqual({
            state: 'open', page: 1, limit: 25
        });
    });

    it('round trips persisted filters and page size', () => {
        const filters = parseAttentionFilters(
            '?state=ignored&kind=webhook_failure&search=delivery&from=2026-08-01&to=2026-08-02&page=3&limit=100'
        );
        expect(parseAttentionFilters(attentionPath(filters).split('?')[1] ?? '')).toEqual(filters);
    });
});
