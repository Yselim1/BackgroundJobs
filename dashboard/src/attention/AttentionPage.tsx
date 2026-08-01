import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { getAttention } from '../api';
import { formatRelativeTime, titleCase } from '../format';
import { Pagination } from '../PageControls';
import { navigate } from '../routes';
import type { AttentionItem, AttentionKind } from '../types';
import { attentionPath, parseAttentionFilters } from './attentionFilters';
import { recoverAttentionPage } from './attentionView';

export function AttentionPage(props: {
    refreshVersion: number;
    onOpen: (attentionId: string) => void;
    onError: (error?: string) => void;
}) {
    const searchKey = window.location.search;
    const filters = useMemo(() => parseAttentionFilters(searchKey), [searchKey]);
    const [items, setItems] = useState<AttentionItem[]>([]);
    const [total, setTotal] = useState(0);
    const [totalPages, setTotalPages] = useState(0);
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState(filters.search ?? '');
    const [kind, setKind] = useState<AttentionKind | 'all'>(filters.kind ?? 'all');
    const [from, setFrom] = useState(filters.from ?? '');
    const [to, setTo] = useState(filters.to ?? '');

    useEffect(() => {
        setSearch(filters.search ?? '');
        setKind(filters.kind ?? 'all');
        setFrom(filters.from ?? '');
        setTo(filters.to ?? '');
    }, [filters.from, filters.kind, filters.search, filters.to]);

    const load = useCallback(async (quiet = false) => {
        if (!quiet) setLoading(true);
        try {
            const result = await getAttention(filters);
            const lastPage = recoverAttentionPage(filters.page, result.totalPages);
            if (filters.page > lastPage) {
                navigate(attentionPath({ ...filters, page: lastPage }), true);
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
    }, [filters, props.onError]);

    useEffect(() => {
        void load();
        const timer = window.setInterval(() => void load(true), 10_000);
        return () => window.clearInterval(timer);
    }, [load, props.refreshVersion]);

    const apply = (event: FormEvent) => {
        event.preventDefault();
        navigate(attentionPath({
            ...filters,
            page: 1,
            ...(kind === 'all' ? { kind: undefined } : { kind }),
            ...(search.trim().length === 0 ? { search: undefined } : { search: search.trim() }),
            ...(from.length === 0 ? { from: undefined } : { from }),
            ...(to.length === 0 ? { to: undefined } : { to })
        }));
    };

    const statePath = (state: typeof filters.state) => attentionPath({ ...filters, state, page: 1 });
    return (
        <>
            <section className='page-heading'>
                <div><p className='eyebrow'>Operations triage</p><h1>Attention</h1><p>Inspect durable execution and webhook failures, then remediate them when appropriate.</p></div>
            </section>
            <nav className='view-tabs' aria-label='Attention states'>
                <a href={statePath('open')} aria-current={filters.state === 'open' ? 'page' : undefined}>Open</a>
                <a href={statePath('ignored')} aria-current={filters.state === 'ignored' ? 'page' : undefined}>Ignored</a>
                <a href={statePath('resolved')} aria-current={filters.state === 'resolved' ? 'page' : undefined}>Resolved</a>
            </nav>
            <section className='panel attention-page-panel'>
                <form className='filter-bar attention-filters' onSubmit={apply}>
                    <label><span>Kind</span><select value={kind} onChange={event => setKind(event.target.value as AttentionKind | 'all')}><option value='all'>All kinds</option><option value='execution_failure'>Execution failures</option><option value='webhook_failure'>Webhook failures</option></select></label>
                    <label className='filter-search'><span>Search</span><input type='search' value={search} maxLength={200} placeholder='Job, execution, delivery, or reason' onChange={event => setSearch(event.target.value)} /></label>
                    <label><span>From</span><input type='date' value={from} onChange={event => setFrom(event.target.value)} /></label>
                    <label><span>To</span><input type='date' value={to} min={from || undefined} onChange={event => setTo(event.target.value)} /></label>
                    <button className='button button-primary'>Apply</button>
                    <button className='button button-quiet' type='button' onClick={() => navigate(attentionPath({ state: filters.state, page: 1, limit: filters.limit }))}>Clear</button>
                </form>
                <div className='table-wrap'>
                    <table>
                        <thead><tr><th>Kind</th><th>Job and source</th><th>Reason</th><th>Occurred</th><th>State</th></tr></thead>
                        <tbody>
                            {items.map(item => (
                                <tr key={item.attentionId} className='clickable-row' onClick={() => props.onOpen(item.attentionId)}>
                                    <td>{item.kind === 'execution_failure' ? 'Execution' : 'Webhook'}</td>
                                    <td><button className='row-link' onClick={event => { event.stopPropagation(); props.onOpen(item.attentionId); }}>{item.jobId}</button><small>{item.sourceId}</small></td>
                                    <td className='reason-cell'>{item.reason}</td>
                                    <td title={new Date(item.occurredAt).toLocaleString()}>{formatRelativeTime(item.occurredAt)}</td>
                                    <td><span className={'status status-' + item.state}><i aria-hidden='true' />{titleCase(item.state)}</span></td>
                                </tr>
                            ))}
                            {!loading && items.length === 0 && <tr><td colSpan={5} className='empty'>No {filters.state} attention items match this view.</td></tr>}
                        </tbody>
                    </table>
                </div>
                <div className='page-size-row'>
                    <label><span>Rows per page</span><select value={filters.limit} onChange={event => navigate(attentionPath({ ...filters, page: 1, limit: Number(event.target.value) as 25 | 50 | 100 }))}><option value={25}>25</option><option value={50}>50</option><option value={100}>100</option></select></label>
                </div>
                <Pagination page={filters.page} pageSize={filters.limit} total={total} totalPages={totalPages} loading={loading} onPage={page => navigate(attentionPath({ ...filters, page }))} />
            </section>
        </>
    );
}
