import { useEffect, useState, type FormEvent } from 'react';
import { deleteManagedSecret, getManagedSecretUsage, putManagedSecret } from '../api';
import { formatRelativeTime, titleCase } from '../format';
import { useModalBehavior } from '../useModalBehavior';
import type { ManagedSecret, SecretUsage, SecurityUser } from '../types';
import { AdminDrawer } from './AdminDrawer';

type ConfigurationState = 'loading' | 'configured' | 'unconfigured' | 'error';
export type SecretLifecycleState = 'none' | 'current' | 'due_soon' | 'overdue';

export function SecretAdmin(props: {
    secrets: ManagedSecret[];
    users: SecurityUser[];
    configurationState: ConfigurationState;
    onRetry: () => Promise<void>;
    onRefresh: () => Promise<void>;
    onError: (error?: string) => void;
}) {
    const [drawerOpen, setDrawerOpen] = useState(false);
    const [rotating, setRotating] = useState<ManagedSecret>();
    const [usage, setUsage] = useState<SecretUsage[]>([]);
    const [usageLoading, setUsageLoading] = useState(false);
    const configured = props.configurationState === 'configured';

    const loadUsage = async (secret: ManagedSecret): Promise<SecretUsage[]> => {
        setUsageLoading(true);
        try {
            const next = await getManagedSecretUsage(secret.name);
            setUsage(next);
            return next;
        } catch (caught) {
            props.onError(caught instanceof Error ? caught.message : String(caught));
            return [];
        } finally { setUsageLoading(false); }
    };

    const open = (secret?: ManagedSecret) => {
        setRotating(secret);
        setUsage([]);
        setDrawerOpen(true);
        if (secret !== undefined) void loadUsage(secret);
    };

    const remove = async (secret: ManagedSecret) => {
        const dependencies = await loadUsage(secret);
        let force = false;
        if (dependencies.length > 0) {
            if (!window.confirm(`${secret.name} is referenced by ${dependencies.length} job(s). Continue to the force-delete confirmation?`)) return;
            if (window.prompt(`Type ${secret.name} to force delete this referenced secret.`) !== secret.name) return;
            force = true;
        } else if (!window.confirm(`Delete managed secret ${secret.name}? This cannot be undone.`)) return;
        try {
            await deleteManagedSecret(secret.name, force);
            setDrawerOpen(false);
            await props.onRefresh();
        } catch (caught) {
            props.onError(caught instanceof Error ? caught.message : String(caught));
            await loadUsage(secret);
        }
    };

    const disabledReason = configurationDisabledReason(props.configurationState);
    return (
        <>
            <section className='panel admin-panel'>
                <div className='panel-heading'>
                    <div><p className='eyebrow'>Encrypted write-only values</p><h2>Managed Secrets</h2></div>
                    <button className='button button-primary' disabled={!configured} title={disabledReason} onClick={() => open()}>Store secret</button>
                </div>
                {props.configurationState === 'loading' && <div className='configuration-warning' role='status'>Checking managed-secret encryption configuration…</div>}
                {props.configurationState === 'unconfigured' && <div className='configuration-warning' role='alert'>Managed-secret encryption is unavailable. Configure <code>SECRETS_MASTER_KEY</code> and restart the backend before storing values.</div>}
                {props.configurationState === 'error' && <div className='configuration-warning configuration-error' role='alert'><span>The server could not report managed-secret configuration.</span><button className='button button-quiet' onClick={() => void props.onRetry()}>Retry</button></div>}
                <div className='security-list admin-secret-list'>
                    {props.secrets.map(secret => {
                        const lifecycle = secretLifecycleState(secret.expiresOn);
                        return (
                            <article key={secret.secretId}>
                                <div><strong>{secret.name}</strong><small>{secret.description ?? 'No description'} · version {secret.keyVersion}</small><small>Owner: {secret.owner?.displayName ?? 'Unassigned'} · Last rotated by {secret.lastRotatedBy?.displayName ?? 'Unknown'}</small></div>
                                <div className='secret-lifecycle'><span className={'status status-' + lifecycle}><i aria-hidden='true' />{lifecycleLabel(lifecycle)}</span><small>{secret.expiresOn === null ? 'No expiry' : `Expires ${secret.expiresOn}`}</small><small>Rotated {formatRelativeTime(secret.updatedAt)}</small></div>
                                <div className='row-actions'><button className='button button-quiet' onClick={() => open(secret)}>Inspect</button><button className='button button-quiet' disabled={!configured} title={disabledReason} onClick={() => open(secret)}>Rotate</button><button className='button button-danger' onClick={() => void remove(secret)}>Delete</button></div>
                            </article>
                        );
                    })}
                    {props.configurationState !== 'loading' && props.secrets.length === 0 && <p className='empty-copy'>No managed secrets have been stored.</p>}
                </div>
            </section>
            <SecretDrawer
                open={drawerOpen}
                secret={rotating}
                users={props.users}
                usage={usage}
                usageLoading={usageLoading}
                configured={configured}
                onDelete={remove}
                onClose={() => setDrawerOpen(false)}
                onSaved={async () => { setDrawerOpen(false); await props.onRefresh(); }}
                onError={props.onError}
            />
        </>
    );
}

function SecretDrawer(props: {
    open: boolean;
    secret?: ManagedSecret;
    users: SecurityUser[];
    usage: SecretUsage[];
    usageLoading: boolean;
    configured: boolean;
    onDelete: (secret: ManagedSecret) => Promise<void>;
    onClose: () => void;
    onSaved: () => Promise<void>;
    onError: (error?: string) => void;
}) {
    const [name, setName] = useState('');
    const [value, setValue] = useState('');
    const [description, setDescription] = useState('');
    const [ownerUserId, setOwnerUserId] = useState('');
    const [expiresOn, setExpiresOn] = useState(defaultExpiryDate());
    const [noExpiry, setNoExpiry] = useState(false);
    const [busy, setBusy] = useState(false);
    useModalBehavior(props.open, props.onClose);
    useEffect(() => {
        setName(props.secret?.name ?? '');
        setDescription(props.secret?.description ?? '');
        setOwnerUserId(props.secret?.owner?.userId ?? '');
        setExpiresOn(defaultExpiryDate());
        setNoExpiry(false);
        setValue('');
    }, [props.open, props.secret]);

    const save = async (event: FormEvent) => {
        event.preventDefault();
        setBusy(true);
        try {
            await putManagedSecret(name, value, description, ownerUserId || null, noExpiry ? null : expiresOn);
            props.onError(undefined);
            await props.onSaved();
        } catch (caught) {
            props.onError(caught instanceof Error ? caught.message : String(caught));
        } finally { setBusy(false); }
    };

    return (
        <AdminDrawer open={props.open} title={props.secret === undefined ? 'Store secret' : `Inspect ${props.secret.name}`} eyebrow='Managed Secrets' onClose={props.onClose}>
            {!props.configured && <div className='configuration-warning' role='alert'><code>SECRETS_MASTER_KEY</code> must be configured before storing or rotating values.</div>}
            {props.secret !== undefined && <SecretUsageList usage={props.usage} loading={props.usageLoading} />}
            <form className='drawer-form' onSubmit={event => void save(event)}>
                <label><span>Secret name</span><input value={name} onChange={event => setName(event.target.value.toUpperCase())} readOnly={props.secret !== undefined} pattern='[A-Z][A-Z0-9_]{1,63}' required /></label>
                <label><span>{props.secret === undefined ? 'Secret value' : 'New secret value'}</span><input type='password' value={value} onChange={event => setValue(event.target.value)} autoComplete='new-password' required /><small>The value is encrypted and cannot be viewed again.</small></label>
                <label><span>Description</span><textarea value={description} onChange={event => setDescription(event.target.value)} rows={3} maxLength={500} /></label>
                <label><span>Owner</span><select value={ownerUserId} onChange={event => setOwnerUserId(event.target.value)}><option value=''>Unassigned</option>{props.users.map(user => <option value={user.userId} key={user.userId}>{user.displayName} · {user.email}</option>)}</select></label>
                <label className='checkbox-control'><input type='checkbox' checked={noExpiry} onChange={event => setNoExpiry(event.target.checked)} /><span>No advisory expiry</span></label>
                {!noExpiry && <label><span>Advisory expiry</span><input type='date' min={todayDate()} value={expiresOn} onChange={event => setExpiresOn(event.target.value)} required /><small>Due-soon warnings begin 14 days before this date. Runtime resolution continues after expiry.</small></label>}
                <button className='button button-primary' disabled={busy || !props.configured}>{busy ? 'Saving…' : props.secret === undefined ? 'Store secret' : 'Rotate secret'}</button>
            </form>
            {props.secret !== undefined && <section className='drawer-subsection audit-shortcuts'><h3>History and deletion</h3><a className='button button-quiet' href={`/audit?resourceType=secret&resourceId=${encodeURIComponent(props.secret.name)}`}>View audit history</a><button className='button button-danger' disabled={busy} onClick={() => void props.onDelete(props.secret!)}>Delete secret</button></section>}
        </AdminDrawer>
    );
}

function SecretUsageList(props: { usage: SecretUsage[]; loading: boolean }) {
    return (
        <section className='drawer-subsection secret-usage'>
            <h3>Current dependencies</h3>
            {props.loading && <p className='empty-copy'>Scanning current job definitions…</p>}
            {!props.loading && props.usage.length === 0 && <p className='empty-copy'>No current jobs reference this secret.</p>}
            {props.usage.map(item => <article key={item.jobId}><div><strong>{item.jobName}</strong><small>{item.jobId} · {titleCase(item.jobStatus)}</small></div><ul>{item.references.map((reference, index) => <li key={reference.kind + reference.path + index}><span>{reference.kind === 'webhook_signing' ? 'Webhook signing' : 'Runtime template'}</span><code>{reference.path}</code></li>)}</ul></article>)}
        </section>
    );
}

export function secretLifecycleState(expiresOn: string | null, today = todayDate()): SecretLifecycleState {
    if (expiresOn === null) return 'none';
    if (expiresOn < today) return 'overdue';
    const due = new Date(today + 'T00:00:00');
    due.setDate(due.getDate() + 14);
    return expiresOn <= localDate(due) ? 'due_soon' : 'current';
}

export function configurationDisabledReason(state: ConfigurationState): string | undefined {
    if (state === 'loading') return 'Checking encryption configuration';
    if (state === 'unconfigured') return 'Configure SECRETS_MASTER_KEY and restart the backend';
    if (state === 'error') return 'Configuration status could not be loaded';
    return undefined;
}

function lifecycleLabel(state: SecretLifecycleState): string {
    return state === 'due_soon' ? 'Due soon' : state === 'none' ? 'No expiry' : titleCase(state);
}

function defaultExpiryDate(): string {
    const date = new Date();
    date.setDate(date.getDate() + 90);
    return localDate(date);
}

function todayDate(): string { return localDate(new Date()); }
function localDate(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}
