import { useMemo, useState } from 'react';
import { formatRelativeTime, titleCase } from '../format';
import type { RoleSummary, SecurityUser } from '../types';
import { UserDrawer } from './UserDrawer';

export function UserAdmin(props: {
    users: SecurityUser[];
    roles: RoleSummary[];
    loading: boolean;
    onRefresh: () => Promise<void>;
    onError: (error?: string) => void;
}) {
    const [search, setSearch] = useState('');
    const [drawer, setDrawer] = useState<'create' | SecurityUser>();
    const filtered = useMemo(() => {
        const query = search.trim().toLowerCase();
        if (query.length === 0) return props.users;
        return props.users.filter(user => (
            user.displayName + ' ' + user.email + ' ' + user.role + ' ' + user.status
        ).toLowerCase().includes(query));
    }, [props.users, search]);

    return (
        <>
            <section className='panel admin-panel'>
                <div className='panel-heading'>
                    <div><p className='eyebrow'>Identities</p><h2>Users</h2></div>
                    <div className='panel-actions'>
                        <label className='search-control'>
                            <span className='sr-only'>Search users</span>
                            <input type='search' placeholder='Search name, email, role, or status' value={search} onChange={event => setSearch(event.target.value)} />
                        </label>
                        <button className='button button-primary' onClick={() => setDrawer('create')}>Create user</button>
                    </div>
                </div>
                <div className='table-wrap'>
                    <table>
                        <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Access</th><th>Last login</th><th>Created</th><th /></tr></thead>
                        <tbody>
                            {filtered.map(user => (
                                <tr key={user.userId}>
                                    <td><strong>{user.displayName}</strong>{user.passwordChangeRequired && <small>Must change password</small>}</td>
                                    <td>{user.email}</td>
                                    <td>{titleCase(user.role)}</td>
                                    <td><UserAccessStatus user={user} /></td>
                                    <td title={user.lastLoginAt === null ? undefined : new Date(user.lastLoginAt).toLocaleString()}>{user.lastLoginAt === null ? 'Never' : formatRelativeTime(user.lastLoginAt)}</td>
                                    <td title={new Date(user.createdAt).toLocaleString()}>{new Date(user.createdAt).toLocaleDateString()}</td>
                                    <td className='row-actions'><button className='button button-quiet' onClick={() => setDrawer(user)}>Manage</button></td>
                                </tr>
                            ))}
                            {!props.loading && filtered.length === 0 && <tr><td className='empty' colSpan={7}>No users match this search.</td></tr>}
                        </tbody>
                    </table>
                </div>
            </section>
            <RoleMatrix roles={props.roles} />
            <UserDrawer
                mode={drawer}
                onClose={() => setDrawer(undefined)}
                onSaved={async () => { setDrawer(undefined); await props.onRefresh(); }}
                onRefresh={props.onRefresh}
                onError={props.onError}
            />
        </>
    );
}

function UserAccessStatus({ user }: { user: SecurityUser }) {
    const automaticallyLocked = user.lockedUntil !== null && Date.parse(user.lockedUntil) > Date.now();
    if (user.status === 'disabled') return <span className='status status-disabled'><i aria-hidden='true' />Disabled</span>;
    if (automaticallyLocked) return <span className='status status-failed'><i aria-hidden='true' />Locked</span>;
    return <span className='status status-active'><i aria-hidden='true' />Active</span>;
}

function RoleMatrix(props: { roles: RoleSummary[] }) {
    const permissions = [...new Set(props.roles.flatMap(item => item.permissions))];
    return (
        <section className='panel admin-panel role-matrix'>
            <div className='panel-heading'><div><p className='eyebrow'>Authorization model</p><h2>Role permissions</h2></div></div>
            <div className='table-wrap'>
                <table>
                    <thead><tr><th>Capability</th>{props.roles.map(item => <th key={item.role}>{titleCase(item.role)}</th>)}</tr></thead>
                    <tbody>{permissions.map(permission => (
                        <tr key={permission}><td>{permissionLabel(permission)}</td>{props.roles.map(role => <td key={role.role} aria-label={`${role.role} ${permission}`}>{role.permissions.includes(permission) ? '✓' : '—'}</td>)}</tr>
                    ))}</tbody>
                </table>
            </div>
        </section>
    );
}

function permissionLabel(permission: string): string {
    return permission.split(':').map(titleCase).join(' · ');
}
