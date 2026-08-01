import type { AttentionFilters, AttentionKind, AttentionState } from '../types';

const STATES = new Set<AttentionState>(['open', 'ignored', 'resolved']);
const KINDS = new Set<AttentionKind>(['execution_failure', 'webhook_failure']);
const LIMITS = new Set([25, 50, 100]);

export function parseAttentionFilters(search: string): AttentionFilters {
    const query = new URLSearchParams(search);
    const stateValue = query.get('state');
    const kindValue = query.get('kind');
    const pageValue = Number(query.get('page') ?? 1);
    const limitValue = Number(query.get('limit') ?? 25);
    const state = STATES.has(stateValue as AttentionState) ? stateValue as AttentionState : 'open';
    const kind = KINDS.has(kindValue as AttentionKind) ? kindValue as AttentionKind : undefined;
    const page = Number.isSafeInteger(pageValue) && pageValue > 0 ? pageValue : 1;
    const limit = LIMITS.has(limitValue) ? limitValue as 25 | 50 | 100 : 25;
    return {
        state,
        page,
        limit,
        ...optional('kind', kind),
        ...optional('search', cleanText(query.get('search'))),
        ...optional('from', cleanDate(query.get('from'))),
        ...optional('to', cleanDate(query.get('to')))
    };
}

export function attentionPath(filters: AttentionFilters): string {
    const query = new URLSearchParams({
        state: filters.state,
        page: String(filters.page),
        limit: String(filters.limit)
    });
    if (filters.kind !== undefined) query.set('kind', filters.kind);
    if (filters.search !== undefined) query.set('search', filters.search);
    if (filters.from !== undefined) query.set('from', filters.from);
    if (filters.to !== undefined) query.set('to', filters.to);
    return '/attention?' + query.toString();
}

function cleanText(value: string | null): string | undefined {
    const trimmed = value?.trim();
    return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function cleanDate(value: string | null): string | undefined {
    return value !== null && /^\d{4}-\d{2}-\d{2}$/u.test(value) ? value : undefined;
}

function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
    return value === undefined ? {} : { [key]: value } as { [P in K]?: V };
}
