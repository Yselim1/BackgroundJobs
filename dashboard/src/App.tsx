import { useCallback, useEffect, useMemo, useState } from 'react';
import {
    cancelExecution,
    executionEventUrl,
    getExecution,
    getExecutions,
    getJobs,
    getOverview,
    runJob
} from './api';
import { formatDuration, formatRelativeTime, titleCase } from './format';
import type { ExecutionDetail, ExecutionStatus, ExecutionSummary, Job, PlatformOverview } from './types';

const EXECUTION_STATUSES: Array<ExecutionStatus | 'all'> = [
    'all', 'running', 'queued', 'failed', 'success', 'cancelled', 'skipped'
];
const TERMINAL = new Set<ExecutionStatus>(['success', 'failed', 'cancelled', 'skipped']);
const SSE_EVENTS = [
    'execution.running', 'execution.success', 'execution.failed', 'execution.cancelled',
    'step.running', 'step.success', 'step.failed', 'step.cancelled', 'step.skipped'
];

export function App() {
    const [overview, setOverview] = useState<PlatformOverview>();
    const [jobs, setJobs] = useState<Job[]>([]);
    const [executions, setExecutions] = useState<ExecutionSummary[]>([]);
    const [status, setStatus] = useState<ExecutionStatus | 'all'>('all');
    const [search, setSearch] = useState('');
    const [selected, setSelected] = useState<ExecutionDetail>();
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState<string>();
    const [error, setError] = useState<string>();

    const refresh = useCallback(async (quiet = false) => {
        if (!quiet) setLoading(true);
        try {
            const [nextOverview, nextJobs, nextExecutions] = await Promise.all([
                getOverview(),
                getJobs(),
                getExecutions(status === 'all' ? undefined : status)
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
            setSelected(await getExecution(executionId));
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
        if (selected === undefined || TERMINAL.has(selected.status)) return;
        const source = new EventSource(executionEventUrl(selected.executionId));
        const update = () => {
            void openExecution(selected.executionId);
            void refresh(true);
        };
        SSE_EVENTS.forEach(event => source.addEventListener(event, update));
        source.onerror = () => source.close();
        return () => source.close();
    }, [openExecution, refresh, selected?.executionId, selected?.status]);

    const filteredJobs = useMemo(() => {
        const needle = search.trim().toLowerCase();
        if (needle.length === 0) return jobs;
        return jobs.filter(job => job.name.toLowerCase().includes(needle) || job.id.toLowerCase().includes(needle));
    }, [jobs, search]);

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
                <div className="system-state">
                    <span className="pulse" aria-hidden="true" />
                    <span>System online</span>
                    <span className="updated">Updated {formatRelativeTime(overview?.generatedAt ?? null)}</span>
                </div>
                <button className="button button-quiet" onClick={() => void refresh()} disabled={loading}>
                    {loading ? 'Refreshing…' : 'Refresh'}
                </button>
            </header>

            <main>
                <section className="hero">
                    <div>
                        <p className="eyebrow">Operations desk</p>
                        <h1>Know what is moving.<br />Intervene when it matters.</h1>
                    </div>
                    <div className="hero-signal">
                        <span>{(overview?.executions.running ?? 0) + (overview?.executions.queued ?? 0)}</span>
                        <small>executions in motion</small>
                    </div>
                </section>

                {error !== undefined && (
                    <div className="error-banner" role="alert">
                        <span>{error}</span>
                        <button onClick={() => setError(undefined)} aria-label="Dismiss error">Dismiss</button>
                    </div>
                )}

                <section className="metrics" aria-label="System overview">
                    <Metric label="Active jobs" value={overview?.jobs.active} note={(overview?.jobs.inactive ?? 0) + ' inactive'} />
                    <Metric label="Running now" value={overview?.executions.running} note={(overview?.executions.queued ?? 0) + ' queued'} tone="teal" />
                    <Metric label="Succeeded · 24h" value={overview?.executions.success24h} note={'Avg ' + formatDuration(overview?.executions.averageSuccessDurationMs24h)} />
                    <Metric label="Needs attention" value={(overview?.executions.failed24h ?? 0) + (overview?.webhooks.failed ?? 0)} note={(overview?.webhooks.failed ?? 0) + ' webhook failures'} tone="orange" />
                </section>

                <section className="workspace">
                    <div className="panel runs-panel">
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
                    </div>

                    <div className="panel jobs-panel">
                        <div className="panel-heading">
                            <div>
                                <p className="eyebrow">Inventory</p>
                                <h2>Jobs</h2>
                            </div>
                            <input
                                className="search"
                                value={search}
                                onChange={event => setSearch(event.target.value)}
                                placeholder="Find a job"
                                aria-label="Find a job"
                            />
                        </div>
                        <div className="job-list">
                            {filteredJobs.map(job => (
                                <article className="job-card" key={job.id}>
                                    <div className="job-state" data-active={job.status === 'active'} aria-hidden="true" />
                                    <div className="job-copy">
                                        <div className="job-title">
                                            <strong>{job.name}</strong>
                                            <span>{job.STEPS.length} steps</span>
                                            {job.STEPS.some(step => step.WHEN !== undefined) && <em>conditional</em>}
                                            {job.STEPS.some(step => step.FOREACH !== undefined) && <em>fan-out</em>}
                                        </div>
                                        <p>{job.schedule === undefined ? 'Manual only' : job.schedule + ' · ' + job.timezone}</p>
                                        <small>Next {job.next_run === null ? 'not scheduled' : formatRelativeTime(job.next_run)}</small>
                                    </div>
                                    <button
                                        className="button button-run"
                                        onClick={() => void handleRun(job.id)}
                                        disabled={busy === 'run:' + job.id}
                                    >
                                        {busy === 'run:' + job.id ? 'Queuing…' : 'Run'}
                                    </button>
                                </article>
                            ))}
                            {!loading && filteredJobs.length === 0 && <p className="empty">No jobs found.</p>}
                        </div>
                    </div>
                </section>
            </main>

            <ExecutionDrawer
                execution={selected}
                busy={busy === 'cancel:' + selected?.executionId}
                onClose={() => setSelected(undefined)}
                onCancel={handleCancel}
            />
        </div>
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

function StatusPill({ status }: { status: string }) {
    return <span className={'status status-' + status}><i aria-hidden="true" />{titleCase(status)}</span>;
}

function ExecutionDrawer(props: {
    execution?: ExecutionDetail;
    busy: boolean;
    onClose: () => void;
    onCancel: (executionId: string) => Promise<void>;
}) {
    const execution = props.execution;
    return (
        <>
            <button
                className={'drawer-backdrop ' + (execution === undefined ? '' : 'visible')}
                onClick={props.onClose}
                aria-label="Close execution details"
                tabIndex={execution === undefined ? -1 : 0}
            />
            <aside className={'drawer ' + (execution === undefined ? '' : 'open')} aria-hidden={execution === undefined}>
                {execution !== undefined && (
                    <>
                        <div className="drawer-head">
                            <div>
                                <p className="eyebrow">{execution.trigger} execution</p>
                                <h2>{execution.jobId}</h2>
                                <code>{execution.executionId}</code>
                            </div>
                            <button className="close" onClick={props.onClose} aria-label="Close">×</button>
                        </div>
                        <div className="drawer-summary">
                            <StatusPill status={execution.status} />
                            <span>{formatDuration(execution.durationMs)}</span>
                            <span>{formatRelativeTime(execution.requestedAt)}</span>
                        </div>
                        {(execution.status === 'queued' || execution.status === 'running') && (
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
                                            <small>
                                                {step.attempts.length} attempt{step.attempts.length === 1 ? '' : 's'}
                                                {step.attempts.some(attempt => attempt.itemIndex !== undefined)
                                                    ? ' across ' + new Set(step.attempts.map(attempt => attempt.itemIndex)).size + ' items'
                                                    : ''}
                                            </small>
                                        )}
                                        {(step.error ?? step.reason) !== undefined && <small className="step-error">{step.error ?? step.reason}</small>}
                                    </div>
                                </article>
                            ))}
                        </div>
                    </>
                )}
            </aside>
        </>
    );
}
