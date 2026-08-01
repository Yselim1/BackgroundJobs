import { useEffect, useState, type FormEvent } from 'react';
import { deleteManagedSecret, putManagedSecret } from '../api';
import { formatRelativeTime } from '../format';
import { useModalBehavior } from '../useModalBehavior';
import type { ManagedSecret } from '../types';
import { AdminDrawer } from './AdminDrawer';

export function SecretAdmin(props: {
    secrets: ManagedSecret[];
    configured: boolean;
    loading: boolean;
    onRefresh: () => Promise<void>;
    onError: (error?: string) => void;
}) {
    const [drawerOpen, setDrawerOpen] = useState(false);
    const [rotating, setRotating] = useState<ManagedSecret>();
    const remove = async (secret: ManagedSecret) => {
        if (!window.confirm(`Delete managed secret ${secret.name}? Existing jobs may fail until it is restored.`)) return;
        try {
            await deleteManagedSecret(secret.name);
            await props.onRefresh();
        } catch (caught) {
            props.onError(caught instanceof Error ? caught.message : String(caught));
        }
    };
    const open = (secret?: ManagedSecret) => { setRotating(secret); setDrawerOpen(true); };

    return (
        <>
            <section className='panel admin-panel'>
                <div className='panel-heading'>
                    <div><p className='eyebrow'>Encrypted values</p><h2>Managed Secrets</h2></div>
                    <button className='button button-primary' disabled={!props.configured} onClick={() => open()}>Store secret</button>
                </div>
                {!props.configured && (
                    <div className='configuration-warning' role='alert'>
                        Managed secret encryption is unavailable. Configure <code>SECRETS_MASTER_KEY</code> before storing values.
                    </div>
                )}
                <div className='security-list admin-secret-list'>
                    {props.secrets.map(secret => (
                        <article key={secret.secretId}>
                            <div><strong>{secret.name}</strong><small>{secret.description ?? 'No description'} · version {secret.keyVersion}</small></div>
                            <span>Updated {formatRelativeTime(secret.updatedAt)}</span>
                            <div className='row-actions'>
                                <button className='button button-quiet' disabled={!props.configured} onClick={() => open(secret)}>Rotate</button>
                                <button className='button button-danger' onClick={() => void remove(secret)}>Delete</button>
                            </div>
                        </article>
                    ))}
                    {!props.loading && props.secrets.length === 0 && <p className='empty-copy'>No managed secrets have been stored.</p>}
                </div>
            </section>
            <SecretDrawer
                open={drawerOpen}
                secret={rotating}
                configured={props.configured}
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
    configured: boolean;
    onClose: () => void;
    onSaved: () => Promise<void>;
    onError: (error?: string) => void;
}) {
    const [name, setName] = useState('');
    const [value, setValue] = useState('');
    const [description, setDescription] = useState('');
    const [busy, setBusy] = useState(false);
    useModalBehavior(props.open, props.onClose);
    useEffect(() => {
        setName(props.secret?.name ?? '');
        setDescription(props.secret?.description ?? '');
        setValue('');
    }, [props.open, props.secret]);

    const save = async (event: FormEvent) => {
        event.preventDefault();
        setBusy(true);
        try {
            await putManagedSecret(name, value, description);
            props.onError(undefined);
            await props.onSaved();
        } catch (caught) {
            props.onError(caught instanceof Error ? caught.message : String(caught));
        } finally {
            setBusy(false);
        }
    };

    return (
        <AdminDrawer open={props.open} title={props.secret === undefined ? 'Store secret' : `Rotate ${props.secret.name}`} eyebrow='Managed Secrets' onClose={props.onClose}>
            {!props.configured && <div className='configuration-warning' role='alert'><code>SECRETS_MASTER_KEY</code> must be configured first.</div>}
            <form className='drawer-form' onSubmit={event => void save(event)}>
                <label><span>Secret name</span><input value={name} onChange={event => setName(event.target.value.toUpperCase())} readOnly={props.secret !== undefined} pattern='[A-Z][A-Z0-9_]{1,63}' required /></label>
                <label><span>Secret value</span><input type='password' value={value} onChange={event => setValue(event.target.value)} autoComplete='new-password' required /></label>
                <label><span>Description</span><textarea value={description} onChange={event => setDescription(event.target.value)} rows={3} /></label>
                <button className='button button-primary' disabled={busy || !props.configured}>
                    {busy ? 'Saving…' : props.secret === undefined ? 'Store secret' : 'Rotate secret'}
                </button>
            </form>
        </AdminDrawer>
    );
}
