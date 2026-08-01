import { useEffect, useState, type FormEvent } from 'react';
import { createSecurityUser, resetSecurityUserPassword, updateSecurityUser } from '../api';
import { useModalBehavior } from '../useModalBehavior';
import type { SecurityRole, SecurityUser } from '../types';
import { AdminDrawer } from './AdminDrawer';

export function UserDrawer(props: {
    mode?: 'create' | SecurityUser;
    onClose: () => void;
    onSaved: () => Promise<void>;
    onError: (error?: string) => void;
}) {
    const open = props.mode !== undefined;
    const editing = typeof props.mode === 'object' ? props.mode : undefined;
    const [displayName, setDisplayName] = useState('');
    const [email, setEmail] = useState('');
    const [role, setRole] = useState<SecurityRole>('viewer');
    const [status, setStatus] = useState<'active' | 'disabled'>('active');
    const [password, setPassword] = useState('');
    const [resetPassword, setResetPassword] = useState('');
    const [busy, setBusy] = useState(false);
    useModalBehavior(open, props.onClose);

    useEffect(() => {
        setDisplayName(editing?.displayName ?? '');
        setEmail(editing?.email ?? '');
        setRole(editing?.role ?? 'viewer');
        setStatus(editing?.status ?? 'active');
        setPassword('');
        setResetPassword('');
    }, [editing, open]);

    const save = async (event: FormEvent) => {
        event.preventDefault();
        const removesAdministrator = editing?.role === 'admin' && (role !== 'admin' || status === 'disabled');
        if (removesAdministrator && !window.confirm('This change removes active administrator access. Continue?')) return;
        setBusy(true);
        try {
            if (editing === undefined) {
                await createSecurityUser({ displayName, email, role, password });
            } else {
                await updateSecurityUser(editing.userId, { displayName, role, status });
            }
            props.onError(undefined);
            await props.onSaved();
        } catch (caught) {
            props.onError(caught instanceof Error ? caught.message : String(caught));
        } finally {
            setBusy(false);
        }
    };

    const reset = async (event: FormEvent) => {
        event.preventDefault();
        if (editing === undefined || !window.confirm(
            `Reset the password for ${editing.email}? Existing sessions and API tokens will be revoked.`
        )) return;
        setBusy(true);
        try {
            await resetSecurityUserPassword(editing.userId, resetPassword);
            setResetPassword('');
            props.onError(undefined);
            window.alert('Password reset. Existing sessions and API tokens were revoked.');
        } catch (caught) {
            props.onError(caught instanceof Error ? caught.message : String(caught));
        } finally {
            setBusy(false);
        }
    };

    return (
        <AdminDrawer
            open={open}
            title={editing === undefined ? 'Create user' : 'Edit user'}
            eyebrow='Administration'
            onClose={props.onClose}
        >
            <form className='drawer-form' onSubmit={event => void save(event)}>
                <label><span>Display name</span><input value={displayName} onChange={event => setDisplayName(event.target.value)} required maxLength={100} /></label>
                <label><span>Email</span><input type='email' value={email} onChange={event => setEmail(event.target.value)} disabled={editing !== undefined} required /></label>
                {editing === undefined && (
                    <label><span>Temporary password</span><input type='password' minLength={12} value={password} onChange={event => setPassword(event.target.value)} required autoComplete='new-password' /></label>
                )}
                <label>
                    <span>Role</span>
                    <select value={role} onChange={event => setRole(event.target.value as SecurityRole)}>
                        <option value='viewer'>Viewer</option><option value='operator'>Operator</option><option value='admin'>Admin</option>
                    </select>
                </label>
                {editing !== undefined && (
                    <label>
                        <span>Status</span>
                        <select value={status} onChange={event => setStatus(event.target.value as 'active' | 'disabled')}>
                            <option value='active'>Active</option><option value='disabled'>Disabled</option>
                        </select>
                    </label>
                )}
                <button className='button button-primary' disabled={busy}>
                    {busy ? 'Saving…' : editing === undefined ? 'Create user' : 'Save changes'}
                </button>
            </form>
            {editing !== undefined && (
                <section className='drawer-subsection'>
                    <h3>Reset password</h3>
                    <p>Resetting a password revokes the user’s existing sessions and API tokens.</p>
                    <form className='drawer-form' onSubmit={event => void reset(event)}>
                        <label><span>New temporary password</span><input type='password' minLength={12} value={resetPassword} onChange={event => setResetPassword(event.target.value)} required autoComplete='new-password' /></label>
                        <button className='button button-danger' disabled={busy}>Confirm password reset</button>
                    </form>
                </section>
            )}
        </AdminDrawer>
    );
}
