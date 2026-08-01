import { useEffect, useState, type FormEvent } from 'react';
import {
    createSecurityUser,
    getSecurityUserAccess,
    resetSecurityUserPassword,
    revokeSecurityUserAccess,
    revokeSecurityUserSession,
    revokeSecurityUserToken,
    unlockSecurityUser,
    updateSecurityUser
} from '../api';
import { formatRelativeTime, titleCase } from '../format';
import { useModalBehavior } from '../useModalBehavior';
import type { SecurityRole, SecurityUser, UserAccessSummary } from '../types';
import { AdminDrawer } from './AdminDrawer';

export function UserDrawer(props: {
    mode?: 'create' | SecurityUser;
    onClose: () => void;
    onSaved: () => Promise<void>;
    onRefresh: () => Promise<void>;
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
    const [access, setAccess] = useState<UserAccessSummary>();
    const [accessLoading, setAccessLoading] = useState(false);
    const [busy, setBusy] = useState(false);
    useModalBehavior(open, props.onClose);

    const loadAccess = async (userId: string) => {
        setAccessLoading(true);
        try {
            setAccess(await getSecurityUserAccess(userId));
            props.onError(undefined);
        } catch (caught) {
            props.onError(caught instanceof Error ? caught.message : String(caught));
        } finally {
            setAccessLoading(false);
        }
    };

    useEffect(() => {
        setDisplayName(editing?.displayName ?? '');
        setEmail(editing?.email ?? '');
        setRole(editing?.role ?? 'viewer');
        setStatus(editing?.status ?? 'active');
        setPassword('');
        setResetPassword('');
        setAccess(undefined);
        if (editing !== undefined) void loadAccess(editing.userId);
    }, [editing, open]);

    const save = async (event: FormEvent) => {
        event.preventDefault();
        const removesAdministrator = editing?.role === 'admin' && (role !== 'admin' || status === 'disabled');
        if (removesAdministrator && !window.confirm('This change removes active administrator access. Continue?')) return;
        setBusy(true);
        try {
            if (editing === undefined) await createSecurityUser({ displayName, email, role, password });
            else await updateSecurityUser(editing.userId, { displayName, role, status });
            props.onError(undefined);
            await props.onSaved();
        } catch (caught) {
            props.onError(caught instanceof Error ? caught.message : String(caught));
        } finally { setBusy(false); }
    };

    const reset = async (event: FormEvent) => {
        event.preventDefault();
        if (editing === undefined || !window.confirm(`Reset the password for ${editing.email}? The user must change it at next login, and existing sessions and API tokens will be revoked.`)) return;
        setBusy(true);
        try {
            await resetSecurityUserPassword(editing.userId, resetPassword);
            setResetPassword('');
            setAccess({ sessions: [], tokens: access?.tokens.map(token => token.revokedAt === null ? { ...token, revokedAt: new Date().toISOString() } : token) ?? [] });
            props.onError(undefined);
            await props.onRefresh();
            window.alert('Temporary password saved. Existing access was revoked and a password change is required.');
        } catch (caught) {
            props.onError(caught instanceof Error ? caught.message : String(caught));
        } finally { setBusy(false); }
    };

    const unlock = async () => {
        if (editing === undefined) return;
        setBusy(true);
        try {
            await unlockSecurityUser(editing.userId);
            await props.onRefresh();
            props.onError(undefined);
        } catch (caught) { props.onError(caught instanceof Error ? caught.message : String(caught)); }
        finally { setBusy(false); }
    };

    const revokeAll = async () => {
        if (editing === undefined || !window.confirm(`Revoke every session and active API token for ${editing.email}?`)) return;
        setBusy(true);
        try {
            const result = await revokeSecurityUserAccess(editing.userId);
            await loadAccess(editing.userId);
            window.alert(`Revoked ${result.sessionsRevoked} session(s) and ${result.tokensRevoked} API token(s).`);
        } catch (caught) { props.onError(caught instanceof Error ? caught.message : String(caught)); }
        finally { setBusy(false); }
    };

    const revokeSession = async (sessionId: string) => {
        if (editing === undefined || !window.confirm('Revoke this browser session?')) return;
        setBusy(true);
        try { await revokeSecurityUserSession(editing.userId, sessionId); await loadAccess(editing.userId); }
        catch (caught) { props.onError(caught instanceof Error ? caught.message : String(caught)); }
        finally { setBusy(false); }
    };

    const revokeToken = async (tokenId: string) => {
        if (editing === undefined || !window.confirm('Revoke this API token?')) return;
        setBusy(true);
        try { await revokeSecurityUserToken(editing.userId, tokenId); await loadAccess(editing.userId); }
        catch (caught) { props.onError(caught instanceof Error ? caught.message : String(caught)); }
        finally { setBusy(false); }
    };

    const locked = editing?.lockedUntil !== null && editing?.lockedUntil !== undefined && Date.parse(editing.lockedUntil) > Date.now();
    return (
        <AdminDrawer open={open} title={editing === undefined ? 'Create user' : 'Manage user'} eyebrow='Administration' onClose={props.onClose}>
            <form className='drawer-form' onSubmit={event => void save(event)}>
                <label><span>Display name</span><input value={displayName} onChange={event => setDisplayName(event.target.value)} required maxLength={100} /></label>
                <label><span>Email</span><input type='email' value={email} onChange={event => setEmail(event.target.value)} disabled={editing !== undefined} required /></label>
                {editing === undefined && <label><span>Temporary password</span><input type='password' minLength={12} value={password} onChange={event => setPassword(event.target.value)} required autoComplete='new-password' /><small>The user must replace this password at first login.</small></label>}
                <label><span>Role</span><select value={role} onChange={event => setRole(event.target.value as SecurityRole)}><option value='viewer'>Viewer</option><option value='operator'>Operator</option><option value='admin'>Admin</option></select></label>
                {editing !== undefined && <label><span>Administrative lock</span><select value={status} onChange={event => setStatus(event.target.value as 'active' | 'disabled')}><option value='active'>Active</option><option value='disabled'>Disabled</option></select></label>}
                <button className='button button-primary' disabled={busy}>{busy ? 'Saving…' : editing === undefined ? 'Create user' : 'Save changes'}</button>
            </form>
            {editing !== undefined && (
                <>
                    {locked && <section className='drawer-subsection lockout-card'><h3>Automatic login lockout</h3><p>Locked until {new Date(editing.lockedUntil!).toLocaleString()} after {editing.failedLoginAttempts} failed attempts.</p><button className='button button-quiet' disabled={busy} onClick={() => void unlock()}>Unlock now</button></section>}
                    <section className='drawer-subsection'>
                        <div className='subsection-heading'><div><h3>Sessions and API tokens</h3><p>Values and credential hashes are never shown.</p></div><button className='button button-danger' disabled={busy || accessLoading} onClick={() => void revokeAll()}>Revoke all</button></div>
                        {accessLoading && <p className='empty-copy'>Loading access…</p>}
                        {access !== undefined && <CredentialInventory access={access} busy={busy} onSession={revokeSession} onToken={revokeToken} />}
                    </section>
                    <section className='drawer-subsection'>
                        <h3>Reset password</h3><p>The temporary password requires replacement and revokes all existing access.</p>
                        <form className='drawer-form' onSubmit={event => void reset(event)}><label><span>New temporary password</span><input type='password' minLength={12} value={resetPassword} onChange={event => setResetPassword(event.target.value)} required autoComplete='new-password' /></label><button className='button button-danger' disabled={busy}>Confirm forced reset</button></form>
                    </section>
                    <section className='drawer-subsection audit-shortcuts'><h3>Audit history</h3><a className='button button-quiet' href={`/audit?resourceType=user&resourceId=${encodeURIComponent(editing.userId)}`}>Changes to this user</a><a className='button button-quiet' href={`/audit?actorUserId=${encodeURIComponent(editing.userId)}`}>Activity by this user</a></section>
                </>
            )}
        </AdminDrawer>
    );
}

function CredentialInventory(props: { access: UserAccessSummary; busy: boolean; onSession: (id: string) => Promise<void>; onToken: (id: string) => Promise<void> }) {
    return (
        <div className='credential-inventory'>
            <h4>Browser sessions</h4>
            {props.access.sessions.map(session => {
                const active = Date.parse(session.expiresAt) > Date.now() && Date.parse(session.idleExpiresAt) > Date.now();
                return <article key={session.sessionId}><div><strong>{session.userAgent ?? 'Unknown client'}</strong><small>{session.ipAddress ?? 'Unknown address'} · Last seen {formatRelativeTime(session.lastSeenAt)}</small><small>{active ? `Expires ${formatRelativeTime(session.idleExpiresAt)}` : 'Expired'}</small></div>{active && <button className='button button-danger' disabled={props.busy} onClick={() => void props.onSession(session.sessionId)}>Revoke</button>}</article>;
            })}
            {props.access.sessions.length === 0 && <p className='empty-copy'>No sessions are stored.</p>}
            <h4>API tokens</h4>
            {props.access.tokens.map(token => {
                const state = token.revokedAt !== null ? 'Revoked' : token.expiresAt !== null && Date.parse(token.expiresAt) <= Date.now() ? 'Expired' : 'Active';
                return <article key={token.tokenId}><div><strong>{token.name}</strong><small>{state} · Created {formatRelativeTime(token.createdAt)}</small><small>{token.lastUsedAt === null ? 'Never used' : `Last used ${formatRelativeTime(token.lastUsedAt)}`}</small></div>{state === 'Active' && <button className='button button-danger' disabled={props.busy} onClick={() => void props.onToken(token.tokenId)}>Revoke</button>}</article>;
            })}
            {props.access.tokens.length === 0 && <p className='empty-copy'>No API tokens are stored.</p>}
        </div>
    );
}
