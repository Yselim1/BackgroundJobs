import { useCallback, useEffect, useState } from 'react';
import { getManagedSecrets, getSecurityUsers } from '../api';
import type { ManagedSecret, SecurityUser } from '../types';
import { SecretAdmin } from './SecretAdmin';
import { UserAdmin } from './UserAdmin';

type AdminTab = 'users' | 'secrets';

export function AdminPage(props: { permissions: string[]; onError: (error?: string) => void }) {
    const canUsers = props.permissions.includes('users:manage');
    const canSecrets = props.permissions.includes('secrets:manage');
    const tab = parseAdminTab(window.location.search, canUsers, canSecrets);
    const [users, setUsers] = useState<SecurityUser[]>([]);
    const [secrets, setSecrets] = useState<ManagedSecret[]>([]);
    const [secretsConfigured, setSecretsConfigured] = useState(false);
    const [loading, setLoading] = useState(true);

    const refresh = useCallback(async () => {
        setLoading(true);
        try {
            const [nextUsers, nextSecrets] = await Promise.all([
                canUsers ? getSecurityUsers() : Promise.resolve([]),
                canSecrets ? getManagedSecrets() : Promise.resolve({ configured: false, items: [] })
            ]);
            setUsers(nextUsers);
            setSecrets(nextSecrets.items);
            setSecretsConfigured(nextSecrets.configured);
            props.onError(undefined);
        } catch (caught) {
            props.onError(caught instanceof Error ? caught.message : String(caught));
        } finally {
            setLoading(false);
        }
    }, [canSecrets, canUsers, props.onError]);

    useEffect(() => { void refresh(); }, [refresh]);
    if (!canUsers && !canSecrets) return <RestrictedAdministration />;
    return (
        <>
            <section className='page-heading admin-heading'>
                <div>
                    <p className='eyebrow'>Administration</p>
                    <h1>Access and managed secrets</h1>
                    <p>Manage dashboard identities and encrypted runtime values.</p>
                </div>
            </section>
            <nav className='view-tabs' aria-label='Administration sections'>
                {canUsers && <a href='/admin?tab=users' aria-current={tab === 'users' ? 'page' : undefined}>Users</a>}
                {canSecrets && <a href='/admin?tab=secrets' aria-current={tab === 'secrets' ? 'page' : undefined}>Managed Secrets</a>}
            </nav>
            {tab === 'users' && canUsers ? (
                <UserAdmin users={users} loading={loading} onRefresh={refresh} onError={props.onError} />
            ) : tab === 'secrets' && canSecrets ? (
                <SecretAdmin
                    secrets={secrets}
                    configured={secretsConfigured}
                    loading={loading}
                    onRefresh={refresh}
                    onError={props.onError}
                />
            ) : <RestrictedAdministration />}
        </>
    );
}

export function parseAdminTab(search: string, canUsers = true, canSecrets = true): AdminTab {
    const requested = new URLSearchParams(search).get('tab');
    if (requested === 'secrets' && canSecrets) return 'secrets';
    if (requested === 'users' && canUsers) return 'users';
    return canUsers ? 'users' : 'secrets';
}

function RestrictedAdministration() {
    return (
        <section className='page-heading'>
            <div>
                <p className='eyebrow'>Restricted</p>
                <h1>Administration</h1>
                <p>You do not have permission to manage users or managed secrets.</p>
            </div>
        </section>
    );
}
