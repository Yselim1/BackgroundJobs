import { useEffect, useState } from 'react';
import { getAttentionItem, getExecution, getIncidentEvents, getSecurityUsers, ignoreAttention, incidentAction, replayIncident, rerunAttention, restoreAttention, retryAttentionWebhook } from '../api';
import { formatRelativeTime, titleCase } from '../format';
import { useModalBehavior } from '../useModalBehavior';
import type { AttentionItem, ExecutionDetail, IncidentEvent, SecurityUser } from '../types';
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
    const [events, setEvents] = useState<IncidentEvent[]>([]);
    const [execution, setExecution] = useState<ExecutionDetail>();
    const [users, setUsers] = useState<SecurityUser[]>([]);
    const item = props.item;
    const actions = item === undefined ? [] : availableAttentionActions(item, props.canManage);
    useModalBehavior(item !== undefined, props.onClose);
    useEffect(() => { if (item !== undefined) void getIncidentEvents(item.attentionId).then(setEvents).catch(() => setEvents([])); }, [item?.attentionId, item?.updatedAt]);
    useEffect(() => {
        if (item === undefined) { setExecution(undefined); return; }
        void getExecution(item.executionId).then(setExecution).catch(() => setExecution(undefined));
        if (props.canManage) void getSecurityUsers().then(items => setUsers(items.filter(user => user.status === 'active'))).catch(() => setUsers([]));
    }, [item?.executionId, props.canManage]);

    const lifecycle = async (action: string, body?: unknown) => {
        if (item === undefined) return; setBusy(action);
        try { await incidentAction(item.attentionId, action, body); const updated = await getAttentionItem(item.attentionId); await props.onChanged(updated); props.onError(undefined); }
        catch (caught) { props.onError(caught instanceof Error ? caught.message : String(caught)); }
        finally { setBusy(undefined); }
    };

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
    const replay = async (resumeStepId?: string) => {
        if (item === undefined) return;
        const description = resumeStepId === undefined ? 'Replay the exact stored execution snapshot and original input?' : `Resume the exact snapshot from replay-safe step ${resumeStepId}?`;
        if (!window.confirm(description)) return;
        setBusy('replay');
        try {
            const queued = await replayIncident(item.attentionId, resumeStepId === undefined ? {} : { resumeStepId });
            await props.onChanged(queued.incident);
            props.onOpenExecution(queued.execution.executionId);
            props.onError(undefined);
        } catch (caught) { props.onError(caught instanceof Error ? caught.message : String(caught)); }
        finally { setBusy(undefined); }
    };
    const resumeSteps = execution === undefined ? [] : execution.jobDefinition.STEPS.filter(step =>
        step.REPLAY_SAFE === true && execution.stepResults[step.ID]?.status === 'failed'
    );

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
                            <span className={'severity severity-' + item.severity}>{item.severity}</span>
                            <span>{item.occurrenceCount} occurrence{item.occurrenceCount === 1 ? '' : 's'}</span>
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
                                {item.state === 'open' && <button className='button button-quiet' disabled={busy !== undefined} onClick={() => void lifecycle('acknowledge')}>Acknowledge</button>}
                                {!['resolved', 'ignored'].includes(item.state) && <button className='button button-quiet' disabled={busy !== undefined} onClick={() => void lifecycle('snooze', { until: new Date(Date.now() + 3_600_000).toISOString() })}>Snooze 1h</button>}
                                {!['resolved'].includes(item.state) && <button className='button button-quiet' disabled={busy !== undefined} onClick={() => { const note = window.prompt('Resolution note'); if (note) void lifecycle('resolve', { note }); }}>Resolve</button>}
                                <label className="assignee-control">Assignee<select value={item.assigneeUserId ?? ''} disabled={busy !== undefined} onChange={event => void lifecycle('assign', { userId: event.target.value || null })}><option value="">Unassigned</option>{users.map(user => <option key={user.userId} value={user.userId}>{user.displayName}</option>)}</select></label>
                                <label className="severity-control">Severity<select value={item.severity} onChange={event => void lifecycle('severity', { severity: event.target.value })}><option value="critical">Critical</option><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option></select></label>
                                {item.kind === 'execution_failure' && !['resolved', 'ignored'].includes(item.state) && <button className='button button-primary' disabled={busy !== undefined} onClick={() => void replay()}>{busy === 'replay' ? 'Queueing…' : 'Replay exact snapshot'}</button>}
                                {resumeSteps.map(step => <button className='button button-quiet' key={step.ID} disabled={busy !== undefined} onClick={() => void replay(step.ID)}>Resume from {step.NAME}</button>)}
                                {actions.includes('ignore') && <button className='button button-quiet' disabled={busy !== undefined} onClick={() => void act('ignore')}>{busy === 'ignore' ? 'Ignoring…' : 'Ignore'}</button>}
                                {actions.includes('rerun') && <button className='button button-quiet' disabled={busy !== undefined} onClick={() => void act('rerun')}>{busy === 'rerun' ? 'Queueing…' : 'Run current definition'}</button>}
                                {actions.includes('retry') && <button className='button button-primary' disabled={busy !== undefined} onClick={() => void act('retry')}>{busy === 'retry' ? 'Requeueing…' : 'Retry webhook'}</button>}
                                {actions.includes('restore') && <button className='button button-primary' disabled={busy !== undefined} onClick={() => void act('restore')}>{busy === 'restore' ? 'Restoring…' : 'Restore to Open'}</button>}
                            </div>
                        ) : <p className='read-only-note'>You have read-only access to operational attention.</p>}
                        <section className="incident-timeline"><h3>Incident timeline</h3>{events.map(event => <article key={event.eventId}><i /><div><strong>{titleCase(event.eventType)}</strong><p>{event.actor.label} · {new Date(event.createdAt).toLocaleString()} · {formatRelativeTime(event.createdAt)}</p>{Object.keys(event.details).length > 0 && <code>{JSON.stringify(event.details)}</code>}</div></article>)}{events.length === 0 && <p className="muted-copy">No timeline events.</p>}</section>
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
