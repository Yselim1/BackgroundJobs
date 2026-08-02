import type { AttentionItem } from '../types';

export type AttentionAction = 'ignore' | 'restore' | 'rerun' | 'retry';
export const INCIDENT_PREVIEW_MIN_WIDTH = 260;
export const INCIDENT_LIST_MIN_WIDTH = 680;
export const INCIDENT_RESIZER_WIDTH = 10;

export function clampIncidentPreviewWidth(containerWidth: number, requestedWidth: number): number {
    const available = Math.max(INCIDENT_PREVIEW_MIN_WIDTH, containerWidth - INCIDENT_LIST_MIN_WIDTH - INCIDENT_RESIZER_WIDTH);
    return Math.round(Math.min(available, Math.max(INCIDENT_PREVIEW_MIN_WIDTH, requestedWidth)));
}

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

export function latestAttentionActivityAt(
    item: Pick<AttentionItem, 'lastOccurredAt' | 'updatedAt'>
): string {
    return Date.parse(item.updatedAt) >= Date.parse(item.lastOccurredAt)
        ? item.updatedAt
        : item.lastOccurredAt;
}
