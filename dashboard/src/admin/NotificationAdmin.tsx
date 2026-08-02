import { useCallback, useEffect, useState } from 'react';
import {
    createNotificationChannel,
    createNotificationPolicy,
    getJobs,
    getManagedSecrets,
    getNotificationChannels,
    getNotificationDeliveries,
    getNotificationPolicies,
    retryNotificationDelivery,
    updateNotificationChannel,
    updateNotificationPolicy
} from '../api';
import { formatRelativeTime, titleCase } from '../format';
import type {
    AttentionKind,
    AttentionSeverity,
    Job,
    ManagedSecret,
    NotificationChannel,
    NotificationChannelKind,
    NotificationDelivery,
    NotificationLifecycleEvent,
    NotificationPolicy
} from '../types';

const lifecycleEvents: NotificationLifecycleEvent[] = ['opened', 'reopened', 'severity_increased', 'resolved'];

export function NotificationAdmin(props: { onError: (error?: string) => void }) {
    const [channels, setChannels] = useState<NotificationChannel[]>([]);
    const [policies, setPolicies] = useState<NotificationPolicy[]>([]);
    const [deliveries, setDeliveries] = useState<NotificationDelivery[]>([]);
    const [secrets, setSecrets] = useState<ManagedSecret[]>([]);
    const [jobs, setJobs] = useState<Job[]>([]);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const load = useCallback(async () => {
        setLoading(true);
        try {
            const [nextChannels, nextPolicies, nextDeliveries, nextSecrets, nextJobs] = await Promise.all([
                getNotificationChannels(), getNotificationPolicies(), getNotificationDeliveries(), getManagedSecrets(), getJobs()
            ]);
            setChannels(nextChannels);
            setPolicies(nextPolicies);
            setDeliveries(nextDeliveries);
            setSecrets(nextSecrets.items);
            setJobs(nextJobs);
            props.onError(undefined);
        } catch (error) { props.onError(error instanceof Error ? error.message : String(error)); }
        finally { setLoading(false); }
    }, [props.onError]);
    useEffect(() => { void load(); }, [load]);
    const act = async (action: () => Promise<unknown>) => {
        setBusy(true);
        try { await action(); await load(); }
        catch (error) { props.onError(error instanceof Error ? error.message : String(error)); }
        finally { setBusy(false); }
    };
    return <div className="notification-admin">
        <ChannelComposer secrets={secrets} disabled={busy} onCreate={input => act(() => createNotificationChannel(input))} />
        <section className="panel admin-panel">
            <div className="panel-heading"><div><p className="eyebrow">Destinations</p><h2>Notification channels</h2></div><span>{channels.length}</span></div>
            <div className="notification-card-grid">{channels.map(channel => <article key={channel.channelId}>
                <div><strong>{channel.name}</strong><small>{titleCase(channel.kind)} · endpoint secret <code>{channel.endpointSecretName}</code></small></div>
                <button className="button button-quiet" disabled={busy} onClick={() => void act(() => updateNotificationChannel(channel.channelId, { enabled: !channel.enabled }, channel.version))}>{channel.enabled ? 'Disable' : 'Enable'}</button>
            </article>)}{!loading && channels.length === 0 && <p className="empty">No channels configured. Endpoint values remain in Managed Secrets.</p>}</div>
        </section>
        <PolicyComposer channels={channels} jobs={jobs} disabled={busy} onCreate={input => act(() => createNotificationPolicy(input))} />
        <section className="panel admin-panel">
            <div className="panel-heading"><div><p className="eyebrow">Routing</p><h2>Notification policies</h2></div><span>{policies.length}</span></div>
            <div className="notification-card-grid">{policies.map(policy => <article key={policy.policyId}>
                <div><strong>{policy.name}</strong><small>{titleCase(policy.minimumSeverity)}+ · {policy.incidentKinds.map(titleCase).join(', ')} · {policy.lifecycleEvents.map(titleCase).join(', ')}</small></div>
                <button className="button button-quiet" disabled={busy} onClick={() => void act(() => updateNotificationPolicy(policy.policyId, { enabled: !policy.enabled }, policy.version))}>{policy.enabled ? 'Disable' : 'Enable'}</button>
            </article>)}{!loading && policies.length === 0 && <p className="empty">No lifecycle notification policies.</p>}</div>
        </section>
        <section className="panel admin-panel">
            <div className="panel-heading"><div><p className="eyebrow">Durable outbox</p><h2>Recent deliveries</h2></div><button className="button button-quiet" onClick={() => void load()}>Refresh</button></div>
            <div className="table-wrap"><table><thead><tr><th>Status</th><th>Attempts</th><th>Response</th><th>Created</th><th>Action</th></tr></thead><tbody>
                {deliveries.map(delivery => <tr key={delivery.deliveryId}><td><span className={'status status-' + delivery.status}><i />{titleCase(delivery.status)}</span>{delivery.lastError && <small className="table-subtle">{delivery.lastError}</small>}</td><td>{delivery.attemptCount}</td><td>{delivery.responseStatus ?? '—'}</td><td>{formatRelativeTime(delivery.createdAt)}</td><td>{delivery.status === 'failed' && <button className="button button-quiet" disabled={busy} onClick={() => void act(() => retryNotificationDelivery(delivery.deliveryId))}>Retry</button>}</td></tr>)}
                {!loading && deliveries.length === 0 && <tr><td colSpan={5} className="empty">No notification deliveries yet.</td></tr>}
            </tbody></table></div>
        </section>
    </div>;
}

function ChannelComposer(props: { secrets: ManagedSecret[]; disabled: boolean; onCreate: (input: { name: string; kind: NotificationChannelKind; endpointSecretName: string; signingSecretName: string | null; enabled: boolean }) => Promise<unknown> }) {
    const [name, setName] = useState('');
    const [kind, setKind] = useState<NotificationChannelKind>('generic_webhook');
    const [endpoint, setEndpoint] = useState('');
    const [signing, setSigning] = useState('');
    return <section className="panel notification-composer"><div className="panel-heading"><div><p className="eyebrow">New destination</p><h2>Add notification channel</h2><p>Reference managed secrets so endpoint URLs and signing keys never appear in this console.</p></div></div>
        <div className="notification-form">
            <label className="notification-field"><span>Channel name</span><input value={name} onChange={event => setName(event.target.value)} placeholder="For example: Operations Slack" /></label>
            <label className="notification-field"><span>Adapter</span><select value={kind} onChange={event => setKind(event.target.value as NotificationChannelKind)}><option value="generic_webhook">Signed generic webhook</option><option value="slack">Slack incoming webhook</option></select></label>
            <label className="notification-field"><span>Endpoint secret</span><select value={endpoint} onChange={event => setEndpoint(event.target.value)}><option value="">Select secret…</option>{props.secrets.map(secret => <option key={secret.name}>{secret.name}</option>)}</select></label>
            {kind === 'generic_webhook' && <label className="notification-field"><span>Signing-key secret</span><select value={signing} onChange={event => setSigning(event.target.value)}><option value="">Select secret…</option>{props.secrets.map(secret => <option key={secret.name}>{secret.name}</option>)}</select></label>}
            <button className="button button-primary notification-submit" disabled={props.disabled || !name.trim() || !endpoint || (kind === 'generic_webhook' && !signing)} onClick={() => void props.onCreate({ name, kind, endpointSecretName: endpoint, signingSecretName: kind === 'generic_webhook' ? signing : null, enabled: true }).then(() => { setName(''); setEndpoint(''); setSigning(''); })}>Add channel</button>
        </div>
    </section>;
}

function PolicyComposer(props: { channels: NotificationChannel[]; jobs: Job[]; disabled: boolean; onCreate: (input: { name: string; channelId: string; enabled: boolean; incidentKinds: AttentionKind[]; minimumSeverity: AttentionSeverity; jobIds: string[] | null; lifecycleEvents: NotificationLifecycleEvent[] }) => Promise<unknown> }) {
    const [name, setName] = useState('');
    const [channelId, setChannelId] = useState('');
    const [severity, setSeverity] = useState<AttentionSeverity>('high');
    const [jobIds, setJobIds] = useState<string[]>([]);
    return <section className="panel notification-composer"><div className="panel-heading"><div><p className="eyebrow">Lifecycle routing</p><h2>Add notification policy</h2><p>Route incident lifecycle events to an enabled channel, optionally limited to selected jobs.</p></div></div>
        <div className="notification-form">
            <label className="notification-field"><span>Policy name</span><input value={name} onChange={event => setName(event.target.value)} placeholder="For example: Critical failures" /></label>
            <label className="notification-field"><span>Channel</span><select value={channelId} onChange={event => setChannelId(event.target.value)}><option value="">Select channel…</option>{props.channels.filter(channel => channel.enabled).map(channel => <option key={channel.channelId} value={channel.channelId}>{channel.name}</option>)}</select></label>
            <label className="notification-field"><span>Minimum severity</span><select value={severity} onChange={event => setSeverity(event.target.value as AttentionSeverity)}>{(['critical', 'high', 'medium', 'low'] as const).map(value => <option key={value}>{titleCase(value)}</option>)}</select></label>
            <label className="notification-field notification-field-tall"><span>Selected jobs <small>Optional</small></span><select multiple value={jobIds} onChange={event => setJobIds(Array.from(event.target.selectedOptions, option => option.value))}>{props.jobs.map(job => <option key={job.id} value={job.id}>{job.name}</option>)}</select><small>Leave empty for all jobs. Use Ctrl/⌘ to select more than one.</small></label>
            <button className="button button-primary notification-submit" disabled={props.disabled || !name.trim() || !channelId} onClick={() => void props.onCreate({ name, channelId, enabled: true, incidentKinds: ['execution_failure', 'webhook_failure'], minimumSeverity: severity, jobIds: jobIds.length === 0 ? null : jobIds, lifecycleEvents }).then(() => { setName(''); setChannelId(''); setJobIds([]); })}>Add policy</button>
        </div>
    </section>;
}
