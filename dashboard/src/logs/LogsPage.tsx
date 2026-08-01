import { useCallback, useEffect, useMemo, useState } from 'react';
import { getExecutions } from '../api';
import { formatDuration, formatRelativeTime, titleCase } from '../format';
import { routeSearchParams, setRouteQuery } from '../routes';
import type { ExecutionStatus, ExecutionSummary, Job } from '../types';

const STATUSES: Array<ExecutionStatus | 'all'> = [
    'all', 'queued', 'running', 'success', 'failed', 'cancelled', 'skipped'
];

interface LogsPageProps {
    jobs: Job[];
    liveVersion: number;
    onError: (message: string | undefined) => void;
}

export function LogsPage(props: LogsPageProps) {
    const initial = useMemo(() => routeSearchParams(), []);
    const [jobId, setJobId] = useState(initial.get('jobId') ?? 'all');
    const [status, setStatus] = useState<ExecutionStatus | 'all'>((initial.get('status') as ExecutionStatus | null) ?? 'all');
    const [trigger, setTrigger] = useState<'all' | 'manual' | 'scheduled'>((initial.get('trigger') as 'manual' | 'scheduled' | null) ?? 'all');
    const [from, setFrom] = useState(initial.get('from') ?? '');
    const [to, setTo] = useState(initial.get('to') ?? '');
    const [sort, setSort] = useState<'newest' | 'oldest'>((initial.get('sort') as 'oldest' | null) ?? 'newest');
    const [items, setItems] = useState<ExecutionSummary[]>([]);
    const [nextCursor, setNextCursor] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);

    const load = useCallback(async (cursor?: string, append = false) => {
        setLoading(true);
        try {
            const result = await getExecutions({
                ...(jobId === 'all' ? {} : { jobId }),
                ...(status === 'all' ? {} : { status }),
                ...(trigger === 'all' ? {} : { trigger }),
                ...(from.length === 0 ? {} : { from: new Date(from).toISOString() }),
                ...(to.length === 0 ? {} : { to: new Date(to).toISOString() }),
                ...(cursor === undefined ? {} : { cursor }),
                order: sort === 'newest' ? 'desc' : 'asc',
                limit: 50
            });
            setItems(current => append ? [...current, ...result.items] : result.items);
            setNextCursor(result.nextCursor);
            props.onError(undefined);
        } catch (caught) {
            props.onError(caught instanceof Error ? caught.message : String(caught));
        } finally {
            setLoading(false);
        }
    }, [from, jobId, props.onError, status, to, trigger]);

    useEffect(() => {
        const path = window.location.pathname.startsWith('/logs/')
            ? window.location.pathname
            : '/logs';
        setRouteQuery(path, { jobId, status, trigger, from, to, sort });
        void load();
    }, [from, jobId, load, sort, status, to, trigger]);

    useEffect(() => { void load(); }, [props.liveVersion]);

    return (
        <section className="logs-page">
            <div className="page-heading">
                <div>
                    <p className="eyebrow">Execution history</p>
                    <h1>Logs</h1>
                    <p>Inspect every queued, running, and terminal execution with durable step and attempt details.</p>
                </div>
            </div>
            <div className="logs-filters">
                <Filter label="Job">
                    <select value={jobId} onChange={event => setJobId(event.target.value)}>
                        <option value="all">All jobs</option>
                        {props.jobs.map(job => <option key={job.id} value={job.id}>{job.name}</option>)}
                    </select>
                </Filter>
                <Filter label="Status">
                    <select value={status} onChange={event => setStatus(event.target.value as ExecutionStatus | 'all')}>
                        {STATUSES.map(value => <option key={value} value={value}>{titleCase(value)}</option>)}
                    </select>
                </Filter>
                <Filter label="Trigger">
                    <select value={trigger} onChange={event => setTrigger(event.target.value as typeof trigger)}>
                        <option value="all">All triggers</option><option value="manual">Manual</option><option value="scheduled">Scheduled</option>
                    </select>
                </Filter>
                <Filter label="From"><input type="datetime-local" value={from} onChange={event => setFrom(event.target.value)} /></Filter>
                <Filter label="To"><input type="datetime-local" value={to} onChange={event => setTo(event.target.value)} /></Filter>
                <Filter label="Sort">
                    <select value={sort} onChange={event => setSort(event.target.value as typeof sort)}>
                        <option value="newest">Newest first</option><option value="oldest">Oldest first</option>
                    </select>
                </Filter>
            </div>
            <div className="panel logs-panel table-wrap">
                <table>
                    <thead><tr><th>Job / execution</th><th>Status</th><th>Trigger</th><th>Requested by</th><th>Requested</th><th>Queue time</th><th>Duration</th></tr></thead>
                    <tbody>
                        {items.map(execution => (
                            <tr key={execution.executionId}>
                                <td>
                                    <a className="row-link" href={'/logs/' + encodeURIComponent(execution.executionId) + window.location.search}>{execution.jobId}</a>
                                    <small>{execution.executionId}</small>
                                </td>
                                <td><Status status={execution.status} /></td>
                                <td>{titleCase(execution.trigger)}</td>
                                <td>{execution.requestedBy.label}</td>
                                <td>{formatRelativeTime(execution.requestedAt)}</td>
                                <td>{execution.startedAt === null ? '—' : formatDuration(Date.parse(execution.startedAt) - Date.parse(execution.requestedAt))}</td>
                                <td>{formatDuration(execution.durationMs)}</td>
                            </tr>
                        ))}
                        {!loading && items.length === 0 && <tr><td className="empty" colSpan={7}>No executions match these filters.</td></tr>}
                    </tbody>
                </table>
            </div>
            {nextCursor !== null && (
                <div className="pagination-actions"><button className="button button-quiet" disabled={loading} onClick={() => void load(nextCursor, true)}>{loading ? 'Loading…' : 'Load 50 more'}</button></div>
            )}
        </section>
    );
}

function Filter(props: { label: string; children: React.ReactNode }) {
    return <label className="log-filter"><span>{props.label}</span>{props.children}</label>;
}

function Status(props: { status: string }) {
    return <span className={'status status-' + props.status}><i aria-hidden="true" />{titleCase(props.status)}</span>;
}
