import { useCallback, useEffect, useMemo, useState } from 'react';
import { getExecutions } from '../api';
import { calendarRangeToApi, parseExactTimestampRange, type ExactTimestampRange } from '../dateFilters';
import { formatDuration, formatRelativeTime, titleCase } from '../format';
import { Pagination } from '../PageControls';
import { pageSize as parsePageSize, positivePage } from '../pagination';
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
    const initialExactRange = useMemo(() => parseExactTimestampRange(initial.get('fromTs'), initial.get('toTs')), [initial]);
    const [jobId, setJobId] = useState(initial.get('jobId') ?? 'all');
    const [status, setStatus] = useState<ExecutionStatus | 'all'>((initial.get('status') as ExecutionStatus | null) ?? 'all');
    const [trigger, setTrigger] = useState<'all' | 'manual' | 'scheduled'>((initial.get('trigger') as 'manual' | 'scheduled' | null) ?? 'all');
    const [from, setFrom] = useState(initialExactRange === undefined ? initial.get('from') ?? '' : '');
    const [to, setTo] = useState(initialExactRange === undefined ? initial.get('to') ?? '' : '');
    const [exactRange, setExactRange] = useState<ExactTimestampRange | undefined>(initialExactRange);
    const [sort, setSort] = useState<'newest' | 'oldest'>((initial.get('sort') as 'oldest' | null) ?? 'newest');
    const [page, setPage] = useState(() => positivePage(initial.get('page')));
    const [pageSize, setPageSize] = useState<25 | 50 | 100>(() => parsePageSize(initial.get('pageSize')));
    const [items, setItems] = useState<ExecutionSummary[]>([]);
    const [total, setTotal] = useState(0);
    const [totalPages, setTotalPages] = useState(0);
    const [loading, setLoading] = useState(false);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const range = exactRange ?? calendarRangeToApi(from, to);
            const result = await getExecutions({
                ...(jobId === 'all' ? {} : { jobId }),
                ...(status === 'all' ? {} : { status }),
                ...(trigger === 'all' ? {} : { trigger }),
                ...range,
                page,
                order: sort === 'newest' ? 'desc' : 'asc',
                limit: pageSize
            });
            const lastValidPage = Math.max(1, result.totalPages);
            if (page > lastValidPage) {
                setPage(lastValidPage);
                return;
            }
            setItems(result.items);
            setTotal(result.total);
            setTotalPages(result.totalPages);
            props.onError(undefined);
        } catch (caught) {
            props.onError(caught instanceof Error ? caught.message : String(caught));
        } finally {
            setLoading(false);
        }
    }, [exactRange, from, jobId, page, pageSize, props.onError, sort, status, to, trigger]);

    useEffect(() => {
        const path = window.location.pathname.startsWith('/logs/')
            ? window.location.pathname
            : '/logs';
        setRouteQuery(path, {
            jobId, status, trigger,
            from: exactRange === undefined ? from : undefined,
            to: exactRange === undefined ? to : undefined,
            fromTs: exactRange?.from,
            toTs: exactRange?.to,
            sort,
            page: String(page), pageSize: String(pageSize)
        });
    }, [exactRange, from, jobId, page, pageSize, sort, status, to, trigger]);

    useEffect(() => { void load(); }, [load, props.liveVersion]);

    const reset = (change: () => void) => {
        setPage(1);
        change();
    };

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
                    <select value={jobId} onChange={event => reset(() => setJobId(event.target.value))}>
                        <option value="all">All jobs</option>
                        {props.jobs.map(job => <option key={job.id} value={job.id}>{job.name}</option>)}
                    </select>
                </Filter>
                <Filter label="Status">
                    <select value={status} onChange={event => reset(() => setStatus(event.target.value as ExecutionStatus | 'all'))}>
                        {STATUSES.map(value => <option key={value} value={value}>{titleCase(value)}</option>)}
                    </select>
                </Filter>
                <Filter label="Trigger">
                    <select value={trigger} onChange={event => reset(() => setTrigger(event.target.value as typeof trigger))}>
                        <option value="all">All triggers</option><option value="manual">Manual</option><option value="scheduled">Scheduled</option>
                    </select>
                </Filter>
                <Filter label="From"><input type="date" value={from} onChange={event => reset(() => { setExactRange(undefined); setFrom(event.target.value); })} /></Filter>
                <Filter label="To"><input type="date" value={to} onChange={event => reset(() => { setExactRange(undefined); setTo(event.target.value); })} /></Filter>
                <Filter label="Sort">
                    <select value={sort} onChange={event => reset(() => setSort(event.target.value as typeof sort))}>
                        <option value="newest">Newest first</option><option value="oldest">Oldest first</option>
                    </select>
                </Filter>
            </div>
            {exactRange !== undefined && <div className="log-time-filter" role="status">
                <span><small>Exact graph interval</small><strong>{formatExactRange(exactRange)}</strong></span>
                <button type="button" onClick={() => reset(() => setExactRange(undefined))}>Clear interval</button>
            </div>}
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
            <Pagination
                page={page}
                pageSize={pageSize}
                total={total}
                totalPages={totalPages}
                loading={loading}
                onPage={setPage}
                onPageSize={value => { setPage(1); setPageSize(value); }}
            />
        </section>
    );
}

function formatExactRange(range: ExactTimestampRange): string {
    const from = new Date(range.from);
    const to = new Date(range.to);
    const sameDay = from.getFullYear() === to.getFullYear()
        && from.getMonth() === to.getMonth()
        && from.getDate() === to.getDate();
    const time = (value: Date) => value.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    if (sameDay) return `${from.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time(from)}–${time(to)}`;
    return `${from.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} – ${to.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
}

function Filter(props: { label: string; children: React.ReactNode }) {
    return <label className="log-filter"><span>{props.label}</span>{props.children}</label>;
}

function Status(props: { status: string }) {
    return <span className={'status status-' + props.status}><i aria-hidden="true" />{titleCase(props.status)}</span>;
}
