import { useMemo, useState } from 'react';
import { formatRelativeTime, titleCase } from '../format';
import type { SecurityUser } from '../types';
import { UserDrawer } from './UserDrawer';

export function UserAdmin(props: {
    users: SecurityUser[];
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
                            <input
                                type='search'
                                placeholder='Search name, email, role, or status'
                                value={search}
                                onChange={event => setSearch(event.target.value)}
                            />
                        </label>
                        <button className='button button-primary' onClick={() => setDrawer('create')}>Create user</button>
                    </div>
                </div>
                <div className='table-wrap'>
                    <table>
                        <thead>
                            <tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Last login</th><th>Created</th><th /></tr>
                        </thead>
                        <tbody>
                            {filtered.map(user => (
                                <tr key={user.userId}>
                                    <td><strong>{user.displayName}</strong></td>
                                    <td>{user.email}</td>
                                    <td>{titleCase(user.role)}</td>
                                    <td><span className={'status status-' + user.status}><i aria-hidden='true' />{titleCase(user.status)}</span></td>
                                    <td title={user.lastLoginAt === null ? undefined : new Date(user.lastLoginAt).toLocaleString()}>
                                        {user.lastLoginAt === null ? 'Never' : formatRelativeTime(user.lastLoginAt)}
                                    </td>
                                    <td title={new Date(user.createdAt).toLocaleString()}>{new Date(user.createdAt).toLocaleDateString()}</td>
                                    <td><button className='button button-quiet' onClick={() => setDrawer(user)}>Edit</button></td>
                                </tr>
                            ))}
                            {!props.loading && filtered.length === 0 && (
                                <tr><td className='empty' colSpan={7}>No users match this search.</td></tr>
                            )}
                        </tbody>
                    </table>
                </div>
            </section>
            <UserDrawer
                mode={drawer}
                onClose={() => setDrawer(undefined)}
                onSaved={async () => { setDrawer(undefined); await props.onRefresh(); }}
                onError={props.onError}
            />
        </>
    );
}
