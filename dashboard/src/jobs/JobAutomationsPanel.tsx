import { useEffect, useState, type FormEvent } from 'react';
import { createChainTrigger, createWebhookTrigger, deleteAutomationTrigger, getAutomationEvents,
    getAutomationTriggers, rotateAutomationToken, updateAutomationTrigger } from '../api';
import { formatRelativeTime, titleCase } from '../format';
import type { AutomationTrigger, AutomationTriggerEvent, Job } from '../types';

export function JobAutomationsPanel(props: { job: Job; jobs: Job[]; canWrite: boolean; refreshVersion?: number; onOpenExecution: (id: string) => Promise<void>; onError: (message: string | undefined) => void }) {
    const [triggers, setTriggers] = useState<AutomationTrigger[]>([]);
    const [events, setEvents] = useState<AutomationTriggerEvent[]>([]);
    const [kind, setKind] = useState<'webhook' | 'job_completion'>('webhook');
    const [name, setName] = useState('');
    const [sourceJobId, setSourceJobId] = useState('');
    const [statuses, setStatuses] = useState(['success']);
    const [credential, setCredential] = useState<{ triggerId: string; token: string }>();
    const [busy, setBusy] = useState<string>();
    const load = async () => {
        try {
            const [nextTriggers, nextEvents] = await Promise.all([getAutomationTriggers(props.job.id), getAutomationEvents(props.job.id)]);
            setTriggers(nextTriggers); setEvents(nextEvents.items); props.onError(undefined);
        } catch (error) { props.onError(error instanceof Error ? error.message : String(error)); }
    };
    useEffect(() => { void load(); }, [props.job.id, props.refreshVersion]);
    const submit = async (event: FormEvent) => {
        event.preventDefault(); setBusy('create');
        try {
            if (kind === 'webhook') {
                const created = await createWebhookTrigger(props.job.id, name);
                setCredential({ triggerId: created.trigger.triggerId, token: created.token });
            } else {
                await createChainTrigger(props.job.id, name, sourceJobId, statuses);
            }
            setName(''); await load();
        } catch (error) { props.onError(error instanceof Error ? error.message : String(error)); }
        finally { setBusy(undefined); }
    };
    const toggle = async (trigger: AutomationTrigger) => {
        setBusy(trigger.triggerId);
        try { await updateAutomationTrigger(props.job.id, trigger.triggerId, { enabled: !trigger.enabled }); await load(); }
        catch (error) { props.onError(error instanceof Error ? error.message : String(error)); }
        finally { setBusy(undefined); }
    };
    const rotate = async (trigger: AutomationTrigger) => {
        if (!window.confirm(`Rotate the token for ${trigger.name}? The previous token will stop working immediately.`)) return;
        setBusy(trigger.triggerId);
        try { const result = await rotateAutomationToken(props.job.id, trigger.triggerId); setCredential({ triggerId: trigger.triggerId, token: result.token }); await load(); }
        catch (error) { props.onError(error instanceof Error ? error.message : String(error)); }
        finally { setBusy(undefined); }
    };
    const remove = async (trigger: AutomationTrigger) => {
        if (!window.confirm(`Delete automation ${trigger.name}?`)) return;
        setBusy(trigger.triggerId);
        try { await deleteAutomationTrigger(props.job.id, trigger.triggerId); await load(); }
        catch (error) { props.onError(error instanceof Error ? error.message : String(error)); }
        finally { setBusy(undefined); }
    };
    const automaticPaused = props.job.status === 'inactive';
    return <div className="automation-layout">
        {automaticPaused && <div className="configuration-warning automation-warning">This job is inactive. Webhook calls are rejected and job-chain events are recorded as skipped until it is activated.</div>}
        {credential !== undefined && <div className="credential-once" role="status"><strong>Copy this token now—it will not be shown again.</strong><code>{credential.token}</code><small>POST {window.location.origin}/hooks/{credential.triggerId} with <code>Authorization: Bearer …</code></small><button className="button button-quiet" onClick={() => void navigator.clipboard.writeText(credential.token)}>Copy token</button><button className="close" onClick={() => setCredential(undefined)}>×</button></div>}
        {props.canWrite && <form className="panel automation-create" onSubmit={event => void submit(event)}><div className="panel-heading"><div><p className="eyebrow">New automation</p><h2>Add trigger</h2><p>Choose how this job should be started, then name the relationship for operators.</p></div></div><div className="automation-form-grid">
            <label className="automation-field"><span>Trigger type</span><select value={kind} onChange={event => setKind(event.target.value as typeof kind)}><option value="webhook">Inbound webhook</option><option value="job_completion">Job completion</option></select></label>
            <label className="automation-field"><span>Automation name</span><input value={name} onChange={event => setName(event.target.value)} required maxLength={100} placeholder="For example: Deploy callback" /></label>
            {kind === 'job_completion' && <><label className="automation-field"><span>Source job</span><select value={sourceJobId} onChange={event => setSourceJobId(event.target.value)} required><option value="">Select a job</option>{props.jobs.filter(job => job.id !== props.job.id).map(job => <option key={job.id} value={job.id}>{job.name}</option>)}</select></label><fieldset className="status-checks"><legend>Start after these terminal states</legend>{['success','failed','cancelled','skipped'].map(status => <label key={status}><input type="checkbox" checked={statuses.includes(status)} onChange={event => setStatuses(event.target.checked ? [...statuses, status] : statuses.filter(item => item !== status))} /> <span>{titleCase(status)}</span></label>)}</fieldset></>}
            <button className="button button-primary automation-submit" disabled={busy === 'create' || (kind === 'job_completion' && statuses.length === 0)}>{busy === 'create' ? 'Creating…' : 'Create trigger'}</button>
        </div></form>}
        <section className="panel"><div className="panel-heading"><div><p className="eyebrow">Configured relationships</p><h2>Triggers</h2></div><span>{triggers.length}</span></div><div className="table-wrap"><table><thead><tr><th>Name</th><th>Direction</th><th>Configuration</th><th>State</th>{props.canWrite && <th>Actions</th>}</tr></thead><tbody>
            {triggers.map(trigger => { const incoming = trigger.targetJobId === props.job.id; return <tr key={trigger.triggerId}><td><strong>{trigger.name}</strong><small className="table-subtle">{titleCase(trigger.kind)}</small></td><td>{trigger.kind === 'webhook' ? 'Inbound' : incoming ? 'Incoming chain' : 'Outgoing chain'}</td><td>{trigger.kind === 'webhook' ? <>Token ending <code>{trigger.tokenSuffix}</code></> : <>{trigger.sourceJobId} → {trigger.targetJobId}<small className="table-subtle">{trigger.terminalStatuses?.join(', ')}</small></>}</td><td>{trigger.enabled ? 'Enabled' : 'Disabled'}<small className="table-subtle">Last used {trigger.lastTriggeredAt === null ? 'never' : formatRelativeTime(trigger.lastTriggeredAt)}</small></td>{props.canWrite && <td><button className="button button-quiet" disabled={busy === trigger.triggerId} onClick={() => void toggle(trigger)}>{trigger.enabled ? 'Disable' : 'Enable'}</button>{trigger.kind === 'webhook' && <button className="button button-quiet" disabled={busy === trigger.triggerId} onClick={() => void rotate(trigger)}>Rotate</button>}<button className="button button-danger" disabled={busy === trigger.triggerId} onClick={() => void remove(trigger)}>Delete</button></td>}</tr>; })}
            {triggers.length === 0 && <tr><td colSpan={props.canWrite ? 5 : 4} className="empty">No automations configured.</td></tr>}
        </tbody></table></div></section>
        <section className="panel"><div className="panel-heading"><div><p className="eyebrow">Durable delivery history</p><h2>Recent trigger events</h2></div><span>{events.length}</span></div><div className="table-wrap"><table><thead><tr><th>Status</th><th>Trigger</th><th>Source</th><th>Queued execution</th><th>Received</th></tr></thead><tbody>
            {events.map(item => <tr key={item.eventId} className={item.queuedExecutionId === null ? '' : 'clickable-row'} onClick={() => item.queuedExecutionId === null ? undefined : void props.onOpenExecution(item.queuedExecutionId)}><td>{titleCase(item.status)}{item.reason !== null && <small className="table-subtle">{item.reason}</small>}</td><td><code>{item.triggerId}</code></td><td>{item.sourceExecutionId === null ? 'Inbound webhook' : <code>{item.sourceExecutionId}</code>}</td><td>{item.queuedExecutionId === null ? '—' : <code>{item.queuedExecutionId}</code>}</td><td>{formatRelativeTime(item.createdAt)}</td></tr>)}
            {events.length === 0 && <tr><td colSpan={5} className="empty">No trigger events yet.</td></tr>}
        </tbody></table></div></section>
    </div>;
}
