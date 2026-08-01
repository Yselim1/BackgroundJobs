import { useState } from 'react';
import { ignoreAttention, rerunAttention, restoreAttention, retryAttentionWebhook } from '../api';
import { formatRelativeTime, titleCase } from '../format';
import { useModalBehavior } from '../useModalBehavior';
import type { AttentionItem } from '../types';
import { availableAttentionActions } from './attentionView';

export function AttentionDrawer(props: {
    item?: AttentionItem;
    canManage: boolean;
    onClose: () => void;
    onChanged: (item: AttentionItem) => Promise<void>;
    onOpenExecution: (executionId: string) => void;
    onError: (error?: string) => void;
}) {
    const [busy, setBusy] = useState<string>();
    const item = props.item;
    const actions = item === undefined ? [] : availableAttentionActions(item, props.canManage);
    useModalBehavior(item !== undefined, props.onClose);

    const act = async (action: 'ignore' | 'restore' | 'rerun' | 'retry') => {
        if (item === undefined) return;
        const confirmation = action === 'rerun'
            ? 'Queue the current job definition with the original execution input?'
            : action === 'retry'
                ? 'Requeue this exact webhook delivery for one immediate attempt?'
                : undefined;
        if (confirmation !== undefined && !window.confirm(confirmation)) return;
        setBusy(action);
        try {
            const updated = action === 'ignore'
                ? await ignoreAttention(item.attentionId)
                : action === 'restore'
                    ? await restoreAttention(item.attentionId)
                    : action === 'rerun'
                        ? await rerunAttention(item.attentionId)
                        : await retryAttentionWebhook(item.attentionId);
            props.onError(undefined);
            await props.onChanged(updated);
        } catch (caught) {
            props.onError(caught instanceof Error ? caught.message : String(caught));
        } finally {
            setBusy(undefined);
        }
    };

    return (
        <>
            <button className={'drawer-backdrop ' + (item === undefined ? '' : 'visible')} onClick={props.onClose} aria-label='Close attention details' tabIndex={item === undefined ? -1 : 0} />
            <aside className={'drawer attention-drawer ' + (item === undefined ? '' : 'open')} aria-hidden={item === undefined} aria-modal='true' role='dialog'>
                {item !== undefined && (
                    <>
                        <div className='drawer-head'>
                            <div><p className='eyebrow'>{item.kind === 'execution_failure' ? 'Execution failure' : 'Webhook failure'}</p><h2>{item.jobId}</h2><code>{item.attentionId}</code></div>
                            <button className='close' onClick={props.onClose} aria-label='Close'>×</button>
                        </div>
                        <div className='drawer-summary'>
                            <span className={'status status-' + item.state}><i aria-hidden='true' />{titleCase(item.state)}</span>
                            <span>{formatRelativeTime(item.occurredAt)}</span>
                        </div>
                        <div className='attention-detail-facts'>
                            <div><span>Job</span><strong>{item.jobId}</strong></div>
                            <div><span>{item.kind === 'execution_failure' ? 'Execution' : 'Delivery'}</span><code>{item.sourceId}</code></div>
                            <div><span>Related execution</span><button className='row-link' onClick={() => props.onOpenExecution(item.executionId)}>{item.executionId}</button></div>
                            <div><span>Occurred</span><strong>{new Date(item.occurredAt).toLocaleString()}</strong></div>
                        </div>
                        <section className='attention-reason-block'><h3>Failure reason</h3><p>{item.reason}</p></section>
                        {item.stateChangedAt !== null && (
                            <section className='attention-state-history'>
                                <h3>State change</h3>
                                <p>{titleCase(item.state)} {formatRelativeTime(item.stateChangedAt)}{item.stateChangedBy === null ? '' : ' by ' + item.stateChangedBy.label}.</p>
                                {item.resolutionAction !== null && <p>Resolution: {item.resolutionAction === 'rerun' ? 'Execution rerun queued' : 'Webhook retry queued'}.</p>}
                            </section>
                        )}
                        {props.canManage ? (
                            <div className='attention-actions'>
                                {actions.includes('ignore') && <button className='button button-quiet' disabled={busy !== undefined} onClick={() => void act('ignore')}>{busy === 'ignore' ? 'Ignoring…' : 'Ignore'}</button>}
                                {actions.includes('rerun') && <button className='button button-primary' disabled={busy !== undefined} onClick={() => void act('rerun')}>{busy === 'rerun' ? 'Queueing…' : 'Rerun'}</button>}
                                {actions.includes('retry') && <button className='button button-primary' disabled={busy !== undefined} onClick={() => void act('retry')}>{busy === 'retry' ? 'Requeueing…' : 'Retry webhook'}</button>}
                                {actions.includes('restore') && <button className='button button-primary' disabled={busy !== undefined} onClick={() => void act('restore')}>{busy === 'restore' ? 'Restoring…' : 'Restore to Open'}</button>}
                            </div>
                        ) : <p className='read-only-note'>You have read-only access to operational attention.</p>}
                        <details className='execution-payload attention-snapshot'>
                            <summary>Failure snapshot</summary>
                            <pre>{JSON.stringify(item.detailSnapshot, null, 2)}</pre>
                            {item.resolutionDetails !== null && <><h4>Resolution details</h4><pre>{JSON.stringify(item.resolutionDetails, null, 2)}</pre></>}
                        </details>
                    </>
                )}
            </aside>
        </>
    );
}
