import type { AttentionItem } from '../types';

export type AttentionAction = 'ignore' | 'restore' | 'rerun' | 'retry';

export function availableAttentionActions(
    item: Pick<AttentionItem, 'kind' | 'state'>,
    canManage: boolean
): AttentionAction[] {
    if (!canManage || item.state === 'resolved') return [];
    if (item.state === 'ignored') return ['restore'];
    return ['ignore', item.kind === 'execution_failure' ? 'rerun' : 'retry'];
}

export function recoverAttentionPage(page: number, totalPages: number): number {
    return Math.min(page, Math.max(1, totalPages));
}
