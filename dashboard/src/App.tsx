import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
    AUTH_EXPIRED_EVENT,
    cancelExecution,
    createSecurityUser,
    deleteManagedSecret,
    executionFeedUrl,
    getAuditEvents,
    getCurrentUser,
    getExecution,
    getExecutions,
    getWebhookDeliveries,
    getJobs,
    getManagedSecrets,
    getOverview,
    getSecurityUsers,
    login,
    logout,
    putManagedSecret,
    runJob,
    updateSecurityUser
} from './api';
import { formatDuration, formatRelativeTime, titleCase } from './format';
import { JobsPage } from './jobs/JobsPage';
import { JobDetailPage } from './jobs/JobDetailPage';
import { LogsPage } from './logs/LogsPage';
import { navigate, parseDashboardRoute, type DashboardRoute } from './routes';
import { useModalBehavior } from './useModalBehavior';
import type {
    AuditEvent,
    AuthSession,
    ExecutionDetail,
    ExecutionStatus,
    ExecutionSummary,
    Job,
    ManagedSecret,
    PlatformOverview,
    SecurityRole,
    SecurityUser,
    WebhookDelivery
} from './types';

const EXECUTION_STATUSES: Array<ExecutionStatus | 'all'> = [
    'all', 'running', 'queued', 'failed', 'success', 'cancelled', 'skipped'
];
function useDashboardRoute(): DashboardRoute {
    const [route, setRoute] = useState<DashboardRoute>(() => parseDashboardRoute(normalizeLegacyHash()));
    useEffect(() => {
        const update = () => setRoute(parseDashboardRoute(normalizeLegacyHash()));
        const followInternalLink = (event: MouseEvent) => {
            if (
                event.defaultPrevented || event.button !== 0 || event.metaKey
                || event.ctrlKey || event.shiftKey || event.altKey
            ) return;
            const target = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null;
            if (target === null || target.target.length > 0 || target.hasAttribute('download')) return;
            const url = new URL(target.href, window.location.href);
            if (url.origin !== window.location.origin) return;
            event.preventDefault();
            navigate(url.pathname + url.search);
        };
        window.addEventListener('popstate', update);
        document.addEventListener('click', followInternalLink);
        return () => {
            window.removeEventListener('popstate', update);
            document.removeEventListener('click', followInternalLink);
        };
    }, []);
    return route;
}

function normalizeLegacyHash(): string {
    if (window.location.hash.startsWith('#/')) {
        window.history.replaceState(null, '', window.location.hash.slice(1));
    }
    return window.location.pathname;
}

export function App() {
    const [session, setSession] = useState<AuthSession | null>();

    useEffect(() => {
        void getCurrentUser()
            .then(setSession)
            .catch(() => setSession(null));
        const expired = () => setSession(null);
        window.addEventListener(AUTH_EXPIRED_EVENT, expired);
        return () => window.removeEventListener(AUTH_EXPIRED_EVENT, expired);
    }, []);

    if (session === undefined) {
        return <div className="auth-loading">Securing operations console…</div>;
    }
    if (session === null) {
        return <LoginScreen onAuthenticated={setSession} />;
    }
    return <Dashboard session={session} onLoggedOut={() => setSession(null)} />;
}

function Dashboard(props: { session: AuthSession; onLoggedOut: () => void }) {
    const route = useDashboardRoute();
    const [overview, setOverview] = useState<PlatformOverview>();
    const [jobs, setJobs] = useState<Job[]>([]);
    const [executions, setExecutions] = useState<ExecutionSummary[]>([]);
    const [status, setStatus] = useState<ExecutionStatus | 'all'>('all');
    const [selected, setSelected] = useState<ExecutionDetail>();
    const [webhooks, setWebhooks] = useState<WebhookDelivery[]>([]);
    const [liveVersion, setLiveVersion] = useState(0);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState<string>();
    const [error, setError] = useState<string>();
    const [securityOpen, setSecurityOpen] = useState(false);
    const canRun = props.session.permissions.includes('jobs:run');
    const canCancel = props.session.permissions.includes('executions:cancel');
    const canWriteJobs = props.session.permissions.includes('jobs:write');
    const canAdminister = props.session.user.role === 'admin';

    const refresh = useCallback(async (quiet = false) => {
        if (!quiet) setLoading(true);
        try {
            const [nextOverview, nextJobs, nextExecutions] = await Promise.all([
                getOverview(),
                getJobs(),
                getExecutions(status === 'all' ? {} : { status })
            ]);
            setOverview(nextOverview);
            setJobs(nextJobs);
            setExecutions(nextExecutions.items);
            setError(undefined);
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        } finally {
            setLoading(false);
        }
    }, [status]);

    const openExecution = useCallback(async (executionId: string) => {
        try {
            const [execution, deliveries] = await Promise.all([
                getExecution(executionId),
                getWebhookDeliveries(executionId)
            ]);
            setSelected(execution);
            setWebhooks(deliveries);
            setError(undefined);
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        }
    }, []);

    useEffect(() => {
        void refresh();
        const timer = window.setInterval(() => void refresh(true), 10_000);
        return () => window.clearInterval(timer);
    }, [refresh]);

    useEffect(() => {
        const source = new EventSource(executionFeedUrl(), { withCredentials: true });
        let refreshTimer: number | undefined;
        source.addEventListener('execution.update', event => {
            const payload = JSON.parse((event as MessageEvent<string>).data) as { executionId?: string };
            if (refreshTimer === undefined) {
                refreshTimer = window.setTimeout(() => {
                    refreshTimer = undefined;
                    setLiveVersion(value => value + 1);
                    void refresh(true);
                }, 250);
            }
            if (payload.executionId !== undefined && payload.executionId === selected?.executionId) {
                void openExecution(payload.executionId);
            }
        });
        source.onerror = () => undefined;
        return () => source.close();
    }, [openExecution, refresh, selected?.executionId]);

    useEffect(() => {
        if (route.page === 'logs' && route.executionId !== undefined) {
            void openExecution(route.executionId);
        }
    }, [openExecution, route.page, route.page === 'logs' ? route.executionId : undefined]);

    const handleRun = async (jobId: string) => {
        setBusy('run:' + jobId);
        try {
            const queued = await runJob(jobId);
            await refresh(true);
            await openExecution(queued.executionId);
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        } finally {
            setBusy(undefined);
        }
    };

    const handleCancel = async (executionId: string) => {
        setBusy('cancel:' + executionId);
        try {
            await cancelExecution(executionId);
            await Promise.all([openExecution(executionId), refresh(true)]);
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        } finally {
            setBusy(undefined);
        }
    };

    const handleLogout = async () => {
        try { await logout(); }
        finally { props.onLoggedOut(); }
    };

    return (
        <div className="shell">
            <header className="topbar">
                <a className="brand" href="/" aria-label="Workline dashboard home">
                    <span className="brand-mark" aria-hidden="true">W</span>
                    <span>
                        <strong>Workline</strong>
                        <small>Background operations</small>
                    </span>
                </a>
                <nav className="primary-nav" aria-label="Primary navigation">
                    <a href="/" aria-current={route.page === 'overview' ? 'page' : undefined}>Overview</a>
                    <a href="/jobs" aria-current={route.page === 'jobs' || route.page === 'job-detail' ? 'page' : undefined}>
                        Jobs <span>{jobs.length}</span>
                    </a>
                    <a href="/logs" aria-current={route.page === 'logs' ? 'page' : undefined}>Logs</a>
                </nav>
                <div className="system-state">
                    <span className="pulse" aria-hidden="true" />
                    <span>System online</span>
                    <span className="updated">Updated {formatRelativeTime(overview?.generatedAt ?? null)}</span>
                </div>
                <div className="account-actions">
                    <div className="account-copy">
                        <strong>{props.session.user.displayName}</strong>
                        <small>{props.session.user.role} · {props.session.user.email}</small>
                    </div>
                    {canAdminister && (
                        <button className="button button-quiet" onClick={() => setSecurityOpen(true)}>
                            Security
                        </button>
                    )}
                    <button className="button button-quiet" onClick={() => void refresh()} disabled={loading}>
                        {loading ? 'Refreshing…' : 'Refresh'}
                    </button>
                    <button className="button button-quiet" onClick={() => void handleLogout()}>
                        Sign out
                    </button>
                </div>
            </header>

            <main>
                {error !== undefined && (
                    <div className="error-banner" role="alert">
                        <span>{error}</span>
                        <button onClick={() => setError(undefined)} aria-label="Dismiss error">Dismiss</button>
                    </div>
                )}

                {route.page === 'overview' ? (
                    <>
                        <section className="metrics" aria-label="System overview">
                            <Metric label="Active jobs" value={overview?.jobs.active} note={(overview?.jobs.inactive ?? 0) + ' inactive'} />
                            <Metric label="Running now" value={overview?.executions.running} note={(overview?.executions.queued ?? 0) + ' queued'} tone="teal" />
                            <Metric label="Succeeded · 24h" value={overview?.executions.success24h} note={'Avg ' + formatDuration(overview?.executions.averageSuccessDurationMs24h)} />
                            <Metric label="Needs attention" value={(overview?.executions.failed24h ?? 0) + (overview?.webhooks.failed ?? 0)} note={(overview?.webhooks.failed ?? 0) + ' webhook failures'} tone="orange" />
                        </section>
                        <section className="operations-strip" aria-label="Worker and queue health">
                            <DetailMetric label="Worker utilization" value={(overview?.workers.utilizationPercent ?? 0) + '%'} note={(overview?.workers.busy ?? 0) + ' of ' + (overview?.workers.capacity ?? 0) + ' workers busy'} />
                            <DetailMetric label="Queue latency · 24h" value={formatDuration(overview?.executions.averageQueueLatencyMs24h)} note={'Oldest queued ' + formatDuration(overview?.executions.oldestQueuedAgeMs)} />
                            <DetailMetric label="Success rate · 24h" value={overview?.executions.successRate24h === null || overview?.executions.successRate24h === undefined ? '—' : overview.executions.successRate24h + '%'} note={(overview?.executions.failed24h ?? 0) + ' failed executions'} />
                        </section>

                        <section className="panel runs-panel">
                        <div className="panel-heading">
                            <div>
                                <p className="eyebrow">Execution stream</p>
                                <h2>Recent runs</h2>
                            </div>
                            <label className="select-control">
                                <span>Status</span>
                                <select value={status} onChange={event => setStatus(event.target.value as ExecutionStatus | 'all')}>
                                    {EXECUTION_STATUSES.map(item => <option key={item} value={item}>{titleCase(item)}</option>)}
                                </select>
                            </label>
                        </div>
                        <div className="table-wrap">
                            <table>
                                <thead>
                                    <tr><th>Job</th><th>State</th><th>Trigger</th><th>Started</th><th>Duration</th></tr>
                                </thead>
                                <tbody>
                                    {executions.map(execution => (
                                        <tr key={execution.executionId}>
                                            <td>
                                                <button className="row-link" onClick={() => void openExecution(execution.executionId)}>
                                                    {execution.jobId}
                                                </button>
                                                <small>{execution.executionId.slice(0, 8)}</small>
                                            </td>
                                            <td><StatusPill status={execution.status} /></td>
                                            <td>{titleCase(execution.trigger)}</td>
                                            <td>{formatRelativeTime(execution.startedAt ?? execution.requestedAt)}</td>
                                            <td>{formatDuration(execution.durationMs)}</td>
                                        </tr>
                                    ))}
                                    {!loading && executions.length === 0 && (
                                        <tr><td colSpan={5} className="empty">No executions match this view.</td></tr>
                                    )}
                                </tbody>
                            </table>
                        </div>
                        </section>
                    </>
                ) : route.page === 'jobs' ? (
                    <JobsPage
                        jobs={jobs}
                        loading={loading}
                        runBusy={busy}
                        canRun={canRun}
                        canWrite={canWriteJobs}
                        onRun={handleRun}
                        onChanged={() => refresh(true)}
                        onError={setError}
                    />
                ) : route.page === 'job-detail' ? (
                    <JobDetailPage
                        job={jobs.find(job => job.id === route.jobId)}
                        canRun={canRun}
                        canWrite={canWriteJobs}
                        liveVersion={liveVersion}
                        runBusy={busy}
                        onRun={handleRun}
                        onOpenExecution={openExecution}
                        onError={setError}
                    />
                ) : (
                    <LogsPage
                        jobs={jobs}
                        liveVersion={liveVersion}
                        onError={setError}
                    />
                )}
            </main>

            <ExecutionDrawer
                execution={selected}
                webhooks={webhooks}
                busy={busy === 'cancel:' + selected?.executionId}
                onClose={() => {
                    setSelected(undefined);
                    setWebhooks([]);
                    if (route.page === 'logs' && route.executionId !== undefined) {
                        navigate('/logs' + window.location.search, true);
                    }
                }}
                onCancel={handleCancel}
                canCancel={canCancel}
            />
            {canAdminister && (
                <SecurityPanel open={securityOpen} onClose={() => setSecurityOpen(false)} />
            )}
        </div>
    );
}

function LoginScreen(props: { onAuthenticated: (session: AuthSession) => void }) {
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string>();

    const submit = async (event: FormEvent) => {
        event.preventDefault();
        setBusy(true);
        try {
            props.onAuthenticated(await login(email, password));
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        } finally {
            setBusy(false);
        }
    };

    return (
        <main className="auth-shell">
            <section className="auth-card">
                <div className="brand auth-brand">
                    <span className="brand-mark" aria-hidden="true">W</span>
                    <span><strong>Workline</strong><small>Secure operations</small></span>
                </div>
                <p className="eyebrow">Authorized access</p>
                <h1>Sign in to the operations desk.</h1>
                <p className="auth-intro">Sessions are stored server-side and protected by an HttpOnly cookie.</p>
                {error !== undefined && <div className="error-banner" role="alert">{error}</div>}
                <form className="auth-form" onSubmit={event => void submit(event)}>
                    <label>
                        <span>Email</span>
                        <input type="email" autoComplete="username" value={email} onChange={event => setEmail(event.target.value)} required />
                    </label>
                    <label>
                        <span>Password</span>
                        <input type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} required />
                    </label>
                    <button className="button button-primary" disabled={busy}>
                        {busy ? 'Signing in…' : 'Sign in'}
                    </button>
                </form>
                <small className="bootstrap-note">First installation? Create the initial administrator with <code>npm run auth:bootstrap</code>.</small>
            </section>
        </main>
    );
}

function SecurityPanel(props: { open: boolean; onClose: () => void }) {
    useModalBehavior(props.open, props.onClose);
    const [users, setUsers] = useState<SecurityUser[]>([]);
    const [secrets, setSecrets] = useState<ManagedSecret[]>([]);
    const [audit, setAudit] = useState<AuditEvent[]>([]);
    const [secretsConfigured, setSecretsConfigured] = useState(false);
    const [error, setError] = useState<string>();
    const [busy, setBusy] = useState<string>();
    const [newUser, setNewUser] = useState({
        email: '', displayName: '', password: '', role: 'viewer' as SecurityRole
    });
    const [newSecret, setNewSecret] = useState({ name: '', value: '', description: '' });

    const refresh = useCallback(async () => {
        try {
            const [nextUsers, nextSecrets, nextAudit] = await Promise.all([
                getSecurityUsers(), getManagedSecrets(), getAuditEvents()
            ]);
            setUsers(nextUsers);
            setSecrets(nextSecrets.items);
            setSecretsConfigured(nextSecrets.configured);
            setAudit(nextAudit);
            setError(undefined);
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        }
    }, []);

    useEffect(() => {
        if (props.open) void refresh();
    }, [props.open, refresh]);

    const submitUser = async (event: FormEvent) => {
        event.preventDefault();
        setBusy('create-user');
        try {
            await createSecurityUser(newUser);
            setNewUser({ email: '', displayName: '', password: '', role: 'viewer' });
            await refresh();
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        } finally {
            setBusy(undefined);
        }
    };

    const changeUser = async (
        user: SecurityUser,
        update: { role?: SecurityRole; status?: 'active' | 'disabled' }
    ) => {
        setBusy('user:' + user.userId);
        try {
            await updateSecurityUser(user.userId, update);
            await refresh();
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        } finally {
            setBusy(undefined);
        }
    };

    const submitSecret = async (event: FormEvent) => {
        event.preventDefault();
        setBusy('create-secret');
        try {
            await putManagedSecret(newSecret.name, newSecret.value, newSecret.description);
            setNewSecret({ name: '', value: '', description: '' });
            await refresh();
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        } finally {
            setBusy(undefined);
        }
    };

    const removeSecret = async (secret: ManagedSecret) => {
        if (!window.confirm('Delete managed secret ' + secret.name + '? Existing jobs may fail until it is restored.')) return;
        setBusy('secret:' + secret.secretId);
        try {
            await deleteManagedSecret(secret.name);
            await refresh();
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        } finally {
            setBusy(undefined);
        }
    };

    return (
        <>
            <button
                className={'drawer-backdrop ' + (props.open ? 'visible' : '')}
                onClick={props.onClose}
                aria-label="Close security console"
                tabIndex={props.open ? 0 : -1}
            />
            <aside
                className={'security-panel ' + (props.open ? 'open' : '')}
                aria-hidden={!props.open}
                aria-modal="true"
                aria-labelledby="security-modal-title"
                role="dialog"
            >
                <div className="drawer-head">
                    <div><p className="eyebrow">Administration</p><h2 id="security-modal-title">Security console</h2></div>
                    <button className="close" onClick={props.onClose} aria-label="Close">×</button>
                </div>
                {error !== undefined && <div className="error-banner" role="alert">{error}</div>}

                <section className="security-section">
                    <div className="section-title"><h3>Users</h3><span>{users.length} identities</span></div>
                    <form className="security-form user-form" onSubmit={event => void submitUser(event)}>
                        <input placeholder="Display name" value={newUser.displayName} onChange={event => setNewUser({ ...newUser, displayName: event.target.value })} required />
                        <input type="email" placeholder="Email" value={newUser.email} onChange={event => setNewUser({ ...newUser, email: event.target.value })} required />
                        <input type="password" minLength={12} placeholder="Temporary password" value={newUser.password} onChange={event => setNewUser({ ...newUser, password: event.target.value })} required />
                        <select value={newUser.role} onChange={event => setNewUser({ ...newUser, role: event.target.value as SecurityRole })}>
                            <option value="viewer">Viewer</option><option value="operator">Operator</option><option value="admin">Admin</option>
                        </select>
                        <button className="button button-primary" disabled={busy === 'create-user'}>Create user</button>
                    </form>
                    <div className="security-list">
                        {users.map(user => (
                            <article key={user.userId}>
                                <div><strong>{user.displayName}</strong><small>{user.email} · {user.status}</small></div>
                                <select
                                    value={user.role}
                                    disabled={busy === 'user:' + user.userId}
                                    onChange={event => void changeUser(user, { role: event.target.value as SecurityRole })}
                                >
                                    <option value="viewer">Viewer</option><option value="operator">Operator</option><option value="admin">Admin</option>
                                </select>
                                <button
                                    className="button button-quiet"
                                    disabled={busy === 'user:' + user.userId}
                                    onClick={() => void changeUser(user, { status: user.status === 'active' ? 'disabled' : 'active' })}
                                >
                                    {user.status === 'active' ? 'Disable' : 'Enable'}
                                </button>
                            </article>
                        ))}
                    </div>
                </section>

                <section className="security-section">
                    <div className="section-title">
                        <h3>Managed secrets</h3>
                        <span>{secretsConfigured ? 'Encryption configured' : 'SECRETS_MASTER_KEY required'}</span>
                    </div>
                    <form className="security-form secret-form" onSubmit={event => void submitSecret(event)}>
                        <input placeholder="SECRET_NAME" value={newSecret.name} onChange={event => setNewSecret({ ...newSecret, name: event.target.value.toUpperCase() })} required />
                        <input type="password" placeholder="Secret value" value={newSecret.value} onChange={event => setNewSecret({ ...newSecret, value: event.target.value })} required />
                        <input placeholder="Description (optional)" value={newSecret.description} onChange={event => setNewSecret({ ...newSecret, description: event.target.value })} />
                        <button className="button button-primary" disabled={!secretsConfigured || busy === 'create-secret'}>Store or rotate</button>
                    </form>
                    <div className="security-list">
                        {secrets.map(secret => (
                            <article key={secret.secretId}>
                                <div><strong>{secret.name}</strong><small>{secret.description ?? 'No description'} · version {secret.keyVersion}</small></div>
                                <span>{formatRelativeTime(secret.updatedAt)}</span>
                                <button className="button button-quiet" onClick={() => void removeSecret(secret)}>Delete</button>
                            </article>
                        ))}
                    </div>
                </section>

                <section className="security-section">
                    <div className="section-title"><h3>Audit trail</h3><span>Append-only</span></div>
                    <div className="audit-list">
                        {audit.map(event => (
                            <article key={event.auditId}>
                                <StatusPill status={event.outcome} />
                                <div><strong>{event.action}</strong><small>{event.actorLabel} · {event.resourceId ?? event.resourceType ?? 'system'}</small></div>
                                <time>{formatRelativeTime(event.createdAt)}</time>
                            </article>
                        ))}
                    </div>
                </section>
            </aside>
        </>
    );
}

function Metric(props: { label: string; value?: number; note: string; tone?: string }) {
    return (
        <article className={'metric ' + (props.tone ?? '')}>
            <span>{props.label}</span>
            <strong>{props.value ?? '—'}</strong>
            <small>{props.note}</small>
        </article>
    );
}

function DetailMetric(props: { label: string; value: string; note: string }) {
    return <article><span>{props.label}</span><strong>{props.value}</strong><small>{props.note}</small></article>;
}

function StatusPill({ status }: { status: string }) {
    return <span className={'status status-' + status}><i aria-hidden="true" />{titleCase(status)}</span>;
}

function ExecutionDrawer(props: {
    execution?: ExecutionDetail;
    webhooks: WebhookDelivery[];
    busy: boolean;
    canCancel: boolean;
    onClose: () => void;
    onCancel: (executionId: string) => Promise<void>;
}) {
    const execution = props.execution;
    useModalBehavior(execution !== undefined, props.onClose);
    return (
        <>
            <button
                className={'drawer-backdrop ' + (execution === undefined ? '' : 'visible')}
                onClick={props.onClose}
                aria-label="Close execution details"
                tabIndex={execution === undefined ? -1 : 0}
            />
            <aside
                className={'drawer ' + (execution === undefined ? '' : 'open')}
                aria-hidden={execution === undefined}
                aria-modal="true"
                aria-labelledby="execution-modal-title"
                role="dialog"
            >
                {execution !== undefined && (
                    <>
                        <div className="drawer-head">
                            <div>
                                <p className="eyebrow">{execution.trigger} execution</p>
                                <h2 id="execution-modal-title">{execution.jobId}</h2>
                                <code>{execution.executionId}</code>
                            </div>
                            <button className="close" onClick={props.onClose} aria-label="Close">×</button>
                        </div>
                        <div className="drawer-summary">
                            <StatusPill status={execution.status} />
                            <span>{formatDuration(execution.durationMs)}</span>
                            <span>{formatRelativeTime(execution.requestedAt)}</span>
                        </div>
                        <div className="execution-facts">
                            <div><span>Requested by</span><strong>{execution.requestedBy.label}</strong><small>{titleCase(execution.requestedBy.type)}</small></div>
                            <div><span>Requested</span><strong>{new Date(execution.requestedAt).toLocaleString()}</strong></div>
                            <div><span>Started</span><strong>{execution.startedAt === null ? 'Not started' : new Date(execution.startedAt).toLocaleString()}</strong></div>
                            <div><span>Finished</span><strong>{execution.finishedAt === null ? 'Not finished' : new Date(execution.finishedAt).toLocaleString()}</strong></div>
                        </div>
                        {execution.cancelRequestedAt !== null && (
                            <div className="execution-cancellation">
                                Cancellation requested {formatRelativeTime(execution.cancelRequestedAt)}
                                {execution.cancelRequestedBy === null ? '' : ' by ' + execution.cancelRequestedBy.label}
                            </div>
                        )}
                        {props.canCancel && (execution.status === 'queued' || execution.status === 'running') && (
                            <button
                                className="button button-cancel"
                                onClick={() => void props.onCancel(execution.executionId)}
                                disabled={props.busy}
                            >
                                {props.busy ? 'Cancelling…' : 'Cancel execution'}
                            </button>
                        )}
                        {execution.error !== null && (
                            <div className="execution-error">
                                <strong>{execution.error.code ?? 'Execution failed'}</strong>
                                <p>{execution.error.message}</p>
                            </div>
                        )}
                        <div className="steps">
                            <h3>Workflow progress</h3>
                            {Object.values(execution.stepResults).map((step, index) => (
                                <article className="step" key={step.stepId}>
                                    <span className="step-number">{String(index + 1).padStart(2, '0')}</span>
                                    <div>
                                        <div className="step-title">
                                            <strong>{step.stepName}</strong>
                                            <StatusPill status={step.status} />
                                        </div>
                                        <p>{step.stepType} · {formatDuration(step.durationMs)}</p>
                                        {step.attempts.length > 0 && (
                                            <div className="attempt-list">
                                                {step.attempts.map((attempt, attemptIndex) => (
                                                    <div key={attemptIndex}>
                                                        <span>Attempt {attempt.attempt}{attempt.itemIndex === undefined ? '' : ' · item ' + attempt.itemIndex}</span>
                                                        <StatusPill status={attempt.status} />
                                                        <small>{formatDuration(attempt.durationMs)}</small>
                                                        {attempt.error !== undefined && <p>{attempt.errorCode === undefined ? '' : attempt.errorCode + ': '}{attempt.error}</p>}
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                        {(step.error ?? step.reason) !== undefined && <small className="step-error">{step.error ?? step.reason}</small>}
                                        {step.output !== undefined && (
                                            <div className="step-output">
                                                <span>Output</span>
                                                <pre>{typeof step.output === 'string'
                                                    ? step.output
                                                    : JSON.stringify(step.output, null, 2)}
                                                </pre>
                                            </div>
                                        )}
                                    </div>
                                </article>
                            ))}
                        </div>
                        <details className="execution-payload">
                            <summary>Input and job snapshot</summary>
                            <h4>Execution input</h4>
                            <pre>{JSON.stringify(execution.input, null, 2)}</pre>
                            <h4>Job definition snapshot</h4>
                            <pre>{JSON.stringify(execution.jobDefinition, null, 2)}</pre>
                        </details>
                        <div className="webhook-section">
                            <h3>Webhook deliveries</h3>
                            {props.webhooks.map(delivery => (
                                <article key={delivery.deliveryId}>
                                    <div><strong>{delivery.eventType}</strong><StatusPill status={delivery.status} /></div>
                                    <code>{delivery.url}</code>
                                    <small>{delivery.attemptCount} attempt{delivery.attemptCount === 1 ? '' : 's'}{delivery.responseStatus === null ? '' : ' · HTTP ' + delivery.responseStatus}</small>
                                    {delivery.lastError !== null && <p>{delivery.lastError}</p>}
                                </article>
                            ))}
                            {props.webhooks.length === 0 && <p className="muted-copy">No webhook deliveries for this execution.</p>}
                        </div>
                    </>
                )}
            </aside>
        </>
    );
}
