import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
    AUTH_EXPIRED_EVENT,
    cancelExecution,
    executionFeedUrl,
    getAttentionItem,
    getCurrentUser,
    getExecution,
    getExecutions,
    getWebhookDeliveries,
    getJobs,
    getOverview,
    login,
    logout,
    runJob,
} from './api';
import { AdminPage } from './admin/AdminPage';
import { AttentionDrawer } from './attention/AttentionDrawer';
import { AttentionPage } from './attention/AttentionPage';
import { AuditPage } from './audit/AuditPage';
import { formatDuration, formatRelativeTime, titleCase } from './format';
import { JobsPage } from './jobs/JobsPage';
import { JobDetailPage } from './jobs/JobDetailPage';
import { LogsPage } from './logs/LogsPage';
import { Pagination } from './PageControls';
import { dashboardNavigation } from './permissions';
import { navigate, parseDashboardRoute, type DashboardRoute } from './routes';
import { useModalBehavior } from './useModalBehavior';
import type {
    AttentionItem,
    AuthSession,
    ExecutionDetail,
    ExecutionStatus,
    ExecutionSummary,
    Job,
    PlatformOverview,
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
    const [executionPage, setExecutionPage] = useState(1);
    const [executionTotal, setExecutionTotal] = useState(0);
    const [executionTotalPages, setExecutionTotalPages] = useState(0);
    const [selected, setSelected] = useState<ExecutionDetail>();
    const [webhooks, setWebhooks] = useState<WebhookDelivery[]>([]);
    const [liveVersion, setLiveVersion] = useState(0);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState<string>();
    const [error, setError] = useState<string>();
    const [selectedAttention, setSelectedAttention] = useState<AttentionItem>();
    const [attentionRefreshVersion, setAttentionRefreshVersion] = useState(0);
    const canRun = props.session.permissions.includes('jobs:run');
    const canCancel = props.session.permissions.includes('executions:cancel');
    const canWriteJobs = props.session.permissions.includes('jobs:write');
    const navigation = dashboardNavigation(props.session.permissions);
    const canReadAudit = navigation.audit;
    const canReadAttention = navigation.attention;
    const canManageAttention = props.session.permissions.includes('attention:manage');
    const canViewAdmin = navigation.administration;

    const refresh = useCallback(async (quiet = false) => {
        if (!quiet) setLoading(true);
        try {
            const [nextOverview, nextJobs, nextExecutions] = await Promise.all([
                getOverview(),
                getJobs(),
                getExecutions({
                    ...(status === 'all' ? {} : { status }),
                    page: executionPage,
                    limit: 10
                })
            ]);
            const lastValidPage = Math.max(1, nextExecutions.totalPages);
            if (executionPage > lastValidPage) {
                setExecutionPage(lastValidPage);
                return;
            }
            setOverview(nextOverview);
            setJobs(nextJobs);
            setExecutions(nextExecutions.items);
            setExecutionTotal(nextExecutions.total);
            setExecutionTotalPages(nextExecutions.totalPages);
            setError(undefined);
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        } finally {
            setLoading(false);
        }
    }, [executionPage, status]);

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

    const openAttention = useCallback(async (attentionId: string) => {
        try {
            setSelectedAttention(await getAttentionItem(attentionId));
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
                    {canReadAttention && <a href="/attention" aria-current={route.page === 'attention' ? 'page' : undefined}>Attention</a>}
                    {canReadAudit && <a href="/audit" aria-current={route.page === 'audit' ? 'page' : undefined}>Audit</a>}
                    {canViewAdmin && <a href="/admin" aria-current={route.page === 'admin' ? 'page' : undefined}>Administration</a>}
                </nav>
                <div className="header-tools">
                    <span className="system-badge" title="Scheduler and dispatchers are online">
                        <span className="pulse" aria-hidden="true" />
                        Online
                    </span>
                    <ProfileMenu
                        session={props.session}
                        loading={loading}
                        onRefresh={() => refresh()}
                        onLogout={handleLogout}
                    />
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
                            <Metric
                                label="Needs attention"
                                value={(overview?.attention.openExecutionFailures ?? 0) + (overview?.attention.openWebhookFailures ?? 0)}
                                note={(overview?.attention.openExecutionFailures ?? 0) + ' executions · ' + (overview?.attention.openWebhookFailures ?? 0) + ' webhooks'}
                                tone="orange"
                                onClick={() => document.getElementById('attention-queue')?.scrollIntoView({ behavior: 'smooth' })}
                            />
                        </section>
                        <section className="operations-strip" aria-label="Worker and queue health">
                            <DetailMetric label="Worker utilization" value={(overview?.workers.utilizationPercent ?? 0) + '%'} note={(overview?.workers.busy ?? 0) + ' of ' + (overview?.workers.capacity ?? 0) + ' workers busy'} />
                            <DetailMetric label="Queue latency · 24h" value={formatDuration(overview?.executions.averageQueueLatencyMs24h)} note={'Oldest queued ' + formatDuration(overview?.executions.oldestQueuedAgeMs)} />
                            <DetailMetric label="Success rate · 24h" value={overview?.executions.successRate24h === null || overview?.executions.successRate24h === undefined ? '—' : overview.executions.successRate24h + '%'} note={(overview?.executions.failed24h ?? 0) + ' failed executions'} />
                        </section>

                        <section className="panel attention-panel" id="attention-queue" aria-label="Attention queue">
                            <div className="panel-heading">
                                <div>
                                    <p className="eyebrow">Attention queue</p>
                                    <h2>Failures to inspect</h2>
                                </div>
                                <a className="button button-quiet" href="/attention">View all</a>
                            </div>
                            <div className="attention-columns">
                                <div>
                                    <h3>Failed executions <span>{overview?.attention.openExecutionFailures ?? 0}</span></h3>
                                    <div className="attention-list">
                                        {overview?.attention.failedExecutions.map(item => (
                                            <button key={item.attentionId} onClick={() => void openAttention(item.attentionId)}>
                                                <span><strong>{item.jobId}</strong><code>{item.sourceId}</code></span>
                                                <span className="attention-reason">{item.reason}</span>
                                                <time>{formatRelativeTime(item.occurredAt)}</time>
                                            </button>
                                        ))}
                                        {(overview?.attention.failedExecutions.length ?? 0) === 0 && <p>No open execution failures.</p>}
                                    </div>
                                </div>
                                <div>
                                    <h3>Failed webhooks <span>{overview?.attention.openWebhookFailures ?? 0}</span></h3>
                                    <div className="attention-list">
                                        {overview?.attention.failedWebhooks.map(item => (
                                            <button key={item.attentionId} onClick={() => void openAttention(item.attentionId)}>
                                                <span><strong>{item.jobId}</strong><code>{item.executionId}</code></span>
                                                <span className="attention-reason">{item.reason}</span>
                                                <time>{formatRelativeTime(item.occurredAt)} · {Number(item.detailSnapshot.attemptCount ?? 0)} attempts</time>
                                            </button>
                                        ))}
                                        {(overview?.attention.failedWebhooks.length ?? 0) === 0 && <p>No open webhook failures.</p>}
                                    </div>
                                </div>
                            </div>
                        </section>

                        <section className="panel runs-panel">
                        <div className="panel-heading">
                            <div>
                                <p className="eyebrow">Execution stream</p>
                                <h2>Recent runs</h2>
                            </div>
                            <label className="select-control">
                                <span>Status</span>
                                <select value={status} onChange={event => {
                                    setExecutionPage(1);
                                    setStatus(event.target.value as ExecutionStatus | 'all');
                                }}>
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
                        <Pagination
                            page={executionPage}
                            pageSize={10}
                            total={executionTotal}
                            totalPages={executionTotalPages}
                            loading={loading}
                            onPage={setExecutionPage}
                        />
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
                ) : route.page === 'attention' ? (
                    canReadAttention ? (
                        <AttentionPage
                            refreshVersion={attentionRefreshVersion}
                            onOpen={attentionId => void openAttention(attentionId)}
                            onError={setError}
                        />
                    ) : (
                        <section className="page-heading"><div><p className="eyebrow">Restricted</p><h1>Attention</h1><p>You do not have permission to inspect attention items.</p></div></section>
                    )
                ) : route.page === 'admin' ? (
                    <AdminPage permissions={props.session.permissions} onError={setError} />
                ) : route.page === 'audit' ? (
                    canReadAudit ? (
                        <AuditPage liveVersion={liveVersion} onError={setError} />
                    ) : (
                        <section className="page-heading"><div><p className="eyebrow">Restricted</p><h1>Audit</h1><p>You do not have permission to view audit events.</p></div></section>
                    )
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
            <AttentionDrawer
                item={selectedAttention}
                canManage={canManageAttention}
                onClose={() => setSelectedAttention(undefined)}
                onChanged={async item => {
                    setSelectedAttention(item);
                    setAttentionRefreshVersion(value => value + 1);
                    await refresh(true);
                }}
                onOpenExecution={executionId => {
                    setSelectedAttention(undefined);
                    void openExecution(executionId);
                }}
                onError={setError}
            />
        </div>
    );
}

function ProfileMenu(props: {
    session: AuthSession;
    loading: boolean;
    onRefresh: () => Promise<void>;
    onLogout: () => Promise<void>;
}) {
    const [open, setOpen] = useState(false);
    const root = useRef<HTMLDivElement>(null);
    const initials = profileInitials(props.session.user.displayName, props.session.user.email);

    useEffect(() => {
        if (!open) return;
        const closeOutside = (event: PointerEvent) => {
            if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
        };
        const closeOnEscape = (event: KeyboardEvent) => {
            if (event.key === 'Escape') setOpen(false);
        };
        document.addEventListener('pointerdown', closeOutside);
        document.addEventListener('keydown', closeOnEscape);
        return () => {
            document.removeEventListener('pointerdown', closeOutside);
            document.removeEventListener('keydown', closeOnEscape);
        };
    }, [open]);

    return (
        <div className='profile-menu' ref={root}>
            <button
                className='profile-trigger'
                aria-label={`Open account menu for ${props.session.user.displayName}`}
                aria-haspopup='menu'
                aria-expanded={open}
                onClick={() => setOpen(value => !value)}
            >
                <span className='profile-avatar' aria-hidden='true'>{initials}</span>
                <span className='profile-chevron' aria-hidden='true'>⌄</span>
            </button>
            {open && (
                <div className='profile-popover' role='menu'>
                    <div className='profile-identity'>
                        <span className='profile-avatar profile-avatar-large' aria-hidden='true'>{initials}</span>
                        <div>
                            <strong>{props.session.user.displayName}</strong>
                            <span>{props.session.user.email}</span>
                            <small>{titleCase(props.session.user.role)} account</small>
                        </div>
                    </div>
                    <div className='profile-actions'>
                        <button
                            role='menuitem'
                            disabled={props.loading}
                            onClick={() => {
                                setOpen(false);
                                void props.onRefresh();
                            }}
                        >
                            <span aria-hidden='true'>↻</span>
                            {props.loading ? 'Refreshing…' : 'Refresh dashboard'}
                        </button>
                        <button
                            className='profile-signout'
                            role='menuitem'
                            onClick={() => {
                                setOpen(false);
                                void props.onLogout();
                            }}
                        >
                            <span aria-hidden='true'>↪</span>
                            Sign out
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}

export function profileInitials(displayName: string, email: string): string {
    const initials = displayName.trim().split(/\s+/u).filter(Boolean).slice(0, 2)
        .map(part => part[0]?.toUpperCase() ?? '').join('');
    return initials || email.trim()[0]?.toUpperCase() || '?';
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

function Metric(props: { label: string; value?: number; note: string; tone?: string; onClick?: () => void }) {
    const content = (
        <>
            <span>{props.label}</span>
            <strong>{props.value ?? '—'}</strong>
            <small>{props.note}</small>
        </>
    );
    if (props.onClick !== undefined) {
        return <button className={'metric metric-action ' + (props.tone ?? '')} onClick={props.onClick}>{content}</button>;
    }
    return <article className={'metric ' + (props.tone ?? '')}>{content}</article>;
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
