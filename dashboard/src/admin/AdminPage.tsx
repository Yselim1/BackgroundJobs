import { useCallback, useEffect, useState } from 'react';
import { getManagedSecrets, getSecurityRoles, getSecurityUsers } from '../api';
import type { ManagedSecret, RoleSummary, SecurityUser } from '../types';
import { SecretAdmin } from './SecretAdmin';
import { SystemAdmin } from './SystemAdmin';
import { UserAdmin } from './UserAdmin';
import { NotificationAdmin } from './NotificationAdmin';

type AdminTab = 'users' | 'secrets' | 'notifications' | 'system';
type LoadState = 'loading' | 'ready' | 'error';

export function AdminPage(props: { permissions: string[]; onError: (error?: string) => void }) {
    const canUsers = props.permissions.includes('users:manage');
    const canSecrets = props.permissions.includes('secrets:manage');
    const canNotifications = props.permissions.includes('workers:manage');
    const canSystem = props.permissions.includes('system:read');
    const tab = parseAdminTab(window.location.search, canUsers, canSecrets, canSystem, canNotifications);

    if (!canUsers && !canSecrets && !canNotifications && !canSystem) return <RestrictedAdministration />;
    return (
        <>
            <section className='page-heading admin-heading'>
                <div>
                    <p className='eyebrow'>Administration</p>
                    <h1>Security and runtime controls</h1>
                    <p>Manage identities, write-only secrets, notification delivery, and safe operational configuration.</p>
                </div>
            </section>
            <nav className='view-tabs' aria-label='Administration sections'>
                {canUsers && <a href='/admin?tab=users' aria-current={tab === 'users' ? 'page' : undefined}>Users</a>}
                {canSecrets && <a href='/admin?tab=secrets' aria-current={tab === 'secrets' ? 'page' : undefined}>Managed Secrets</a>}
                {canNotifications && <a href='/admin?tab=notifications' aria-current={tab === 'notifications' ? 'page' : undefined}>Notifications</a>}
                {canSystem && <a href='/admin?tab=system' aria-current={tab === 'system' ? 'page' : undefined}>System</a>}
            </nav>
            {tab === 'users' && canUsers ? (
                <UsersTab onError={props.onError} />
            ) : tab === 'secrets' && canSecrets ? (
                <SecretsTab onError={props.onError} />
            ) : tab === 'notifications' && canNotifications ? (
                <NotificationAdmin onError={props.onError} />
            ) : tab === 'system' && canSystem ? (
                <SystemAdmin onError={props.onError} />
            ) : <RestrictedAdministration />}
        </>
    );
}

function UsersTab(props: { onError: (error?: string) => void }) {
    const [users, setUsers] = useState<SecurityUser[]>([]);
    const [roles, setRoles] = useState<RoleSummary[]>([]);
    const [state, setState] = useState<LoadState>('loading');
    const load = useCallback(async () => {
        setState('loading');
        try {
            const [nextUsers, nextRoles] = await Promise.all([getSecurityUsers(), getSecurityRoles()]);
            setUsers(nextUsers);
            setRoles(nextRoles);
            setState('ready');
            props.onError(undefined);
        } catch (caught) {
            setState('error');
            props.onError(caught instanceof Error ? caught.message : String(caught));
        }
    }, [props.onError]);
    useEffect(() => { void load(); }, [load]);
    if (state === 'error') return <LoadFailure title='Users unavailable' onRetry={load} />;
    return <UserAdmin users={users} roles={roles} loading={state === 'loading'} onRefresh={load} onError={props.onError} />;
}

function SecretsTab(props: { onError: (error?: string) => void }) {
    const [secrets, setSecrets] = useState<ManagedSecret[]>([]);
    const [users, setUsers] = useState<SecurityUser[]>([]);
    const [configured, setConfigured] = useState<boolean>();
    const [state, setState] = useState<LoadState>('loading');
    const load = useCallback(async () => {
        setState('loading');
        try {
            const [nextSecrets, nextUsers] = await Promise.all([getManagedSecrets(), getSecurityUsers()]);
            setSecrets(nextSecrets.items);
            setConfigured(nextSecrets.configured);
            setUsers(nextUsers);
            setState('ready');
            props.onError(undefined);
        } catch (caught) {
            setState('error');
            props.onError(caught instanceof Error ? caught.message : String(caught));
        }
    }, [props.onError]);
    useEffect(() => { void load(); }, [load]);
    return (
        <SecretAdmin
            secrets={secrets}
            users={users}
            configurationState={state === 'error' ? 'error' : state === 'loading' ? 'loading' : configured ? 'configured' : 'unconfigured'}
            onRetry={load}
            onRefresh={load}
            onError={props.onError}
        />
    );
}

export function parseAdminTab(
    search: string,
    canUsers = true,
    canSecrets = true,
    canSystem = true,
    canNotifications = false
): AdminTab {
    const requested = new URLSearchParams(search).get('tab');
    if (requested === 'secrets' && canSecrets) return 'secrets';
    if (requested === 'system' && canSystem) return 'system';
    if (requested === 'notifications' && canNotifications) return 'notifications';
    if (requested === 'users' && canUsers) return 'users';
    if (canUsers) return 'users';
    if (canSecrets) return 'secrets';
    if (canNotifications) return 'notifications';
    return 'system';
}

function LoadFailure(props: { title: string; onRetry: () => Promise<void> }) {
    return (
        <section className='panel admin-panel configuration-error' role='alert'>
            <div><p className='eyebrow'>Request failed</p><h2>{props.title}</h2><p>The server could not load this Administration section.</p></div>
            <button className='button button-primary' onClick={() => void props.onRetry()}>Retry</button>
        </section>
    );
}

function RestrictedAdministration() {
    return (
        <section className='page-heading'>
            <div><p className='eyebrow'>Restricted</p><h1>Administration</h1><p>You do not have permission to manage this section.</p></div>
        </section>
    );
}
