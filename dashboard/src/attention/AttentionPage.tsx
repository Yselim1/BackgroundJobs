import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { bulkIncidentAction, getAttention, getSecurityUsers } from '../api';
import { formatRelativeTime, titleCase } from '../format';
import { Pagination } from '../PageControls';
import { navigate } from '../routes';
import type { AttentionItem, AttentionKind, SecurityUser } from '../types';
import { attentionPath, parseAttentionFilters } from './attentionFilters';
import { clampIncidentPreviewWidth, INCIDENT_PREVIEW_MIN_WIDTH, INCIDENT_RESIZER_WIDTH, latestAttentionActivityAt, recoverAttentionPage } from './attentionView';

const INCIDENT_PREVIEW_WIDTH_KEY = 'workline:attention-preview-width';

export function AttentionPage(props: {
    refreshVersion: number;
    onOpen: (attentionId: string) => void;
    onError: (error?: string) => void;
    canManage: boolean;
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
    const [activeId, setActiveId] = useState<string>();
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [busy, setBusy] = useState(false);
    const [users, setUsers] = useState<SecurityUser[]>([]);
    const [previewWidth, setPreviewWidth] = useState(() => {
        const stored = Number(window.localStorage.getItem(INCIDENT_PREVIEW_WIDTH_KEY));
        return Number.isFinite(stored) && stored > 0 ? stored : 320;
    });
    const [resizingPreview, setResizingPreview] = useState(false);
    const resizingPreviewRef = useRef(false);
    const splitRef = useRef<HTMLDivElement>(null);

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
    useEffect(() => {
        if (props.canManage) void getSecurityUsers().then(items => setUsers(items.filter(user => user.status === 'active'))).catch(() => setUsers([]));
    }, [props.canManage]);

    useEffect(() => {
        const split = splitRef.current;
        if (split === null || typeof ResizeObserver === 'undefined') return;
        const observer = new ResizeObserver(() => setPreviewWidth(current => clampIncidentPreviewWidth(split.clientWidth, current)));
        observer.observe(split);
        return () => observer.disconnect();
    }, []);

    useEffect(() => {
        const keyboard = (event: KeyboardEvent) => {
            if (items.length === 0 || !['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key)) return;
            const index = Math.max(0, items.findIndex(item => item.attentionId === activeId));
            if (event.key === 'Enter') { if (activeId) props.onOpen(activeId); return; }
            event.preventDefault();
            const next = event.key === 'ArrowDown' ? Math.min(items.length - 1, index + 1) : Math.max(0, index - 1);
            setActiveId(items[next]?.attentionId);
        };
        window.addEventListener('keydown', keyboard); return () => window.removeEventListener('keydown', keyboard);
    }, [activeId, items, props.onOpen]);

    const bulk = async (action: string, value?: unknown) => {
        if (selected.size === 0) return; setBusy(true);
        try { await bulkIncidentAction([...selected], action, value); setSelected(new Set()); await load(); }
        catch (error) { props.onError(error instanceof Error ? error.message : String(error)); }
        finally { setBusy(false); }
    };

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
    const resizePreviewFromPointer = (event: ReactPointerEvent<HTMLDivElement>, persist: boolean) => {
        const split = splitRef.current;
        if (split === null) return;
        const bounds = split.getBoundingClientRect();
        const next = clampIncidentPreviewWidth(bounds.width, bounds.right - event.clientX);
        setPreviewWidth(next);
        if (persist) window.localStorage.setItem(INCIDENT_PREVIEW_WIDTH_KEY, String(next));
    };
    const resizePreviewFromKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        const splitWidth = splitRef.current?.clientWidth ?? 1000;
        const next = clampIncidentPreviewWidth(splitWidth, previewWidth + (event.key === 'ArrowLeft' ? 24 : -24));
        setPreviewWidth(next);
        window.localStorage.setItem(INCIDENT_PREVIEW_WIDTH_KEY, String(next));
    };
    return (
        <>
            <section className='page-heading'>
                <div><p className='eyebrow'>Operations triage</p><h1>Attention</h1><p>Inspect durable execution and webhook failures, then remediate them when appropriate.</p></div>
            </section>
            <nav className='view-tabs' aria-label='Attention states'>
                <a href={statePath('open')} aria-current={filters.state === 'open' ? 'page' : undefined}>Open</a>
                <a href={statePath('acknowledged')} aria-current={filters.state === 'acknowledged' ? 'page' : undefined}>Acknowledged</a>
                <a href={statePath('snoozed')} aria-current={filters.state === 'snoozed' ? 'page' : undefined}>Snoozed</a>
                <a href={statePath('ignored')} aria-current={filters.state === 'ignored' ? 'page' : undefined}>Ignored</a>
                <a href={statePath('resolved')} aria-current={filters.state === 'resolved' ? 'page' : undefined}>Resolved</a>
            </nav>
            <section className='panel attention-page-panel'>
                {props.canManage && selected.size > 0 && <div className="bulk-toolbar"><strong>{selected.size} selected</strong>
                    <select aria-label="Assign selected incidents" defaultValue="" disabled={busy} onChange={event => { if (event.target.value) void bulk('assign', event.target.value); }}><option value="">Assign…</option>{users.map(user => <option key={user.userId} value={user.userId}>{user.displayName}</option>)}</select>
                    <button disabled={busy} onClick={() => void bulk('acknowledge')}>Acknowledge</button><button disabled={busy} onClick={() => void bulk('severity', 'critical')}>Critical</button><button disabled={busy} onClick={() => void bulk('snooze', new Date(Date.now() + 3_600_000).toISOString())}>Snooze 1h</button><button disabled={busy} onClick={() => void bulk('ignore')}>Ignore</button><button disabled={busy} onClick={() => void bulk('replay')}>Full replay</button><button disabled={busy} onClick={() => { const step = window.prompt('Replay-safe failed step ID'); if (step?.trim()) void bulk('resume', step.trim()); }}>Step resume…</button><button disabled={busy} onClick={() => void bulk('retry_webhook')}>Retry webhooks</button><button disabled={busy} onClick={() => void bulk('resolve', 'Resolved in bulk triage.')}>Resolve</button><button onClick={() => setSelected(new Set())}>Clear</button>
                </div>}
                <form className='filter-bar attention-filters' onSubmit={apply}>
                    <label><span>Kind</span><select value={kind} onChange={event => setKind(event.target.value as AttentionKind | 'all')}><option value='all'>All kinds</option><option value='execution_failure'>Execution failures</option><option value='webhook_failure'>Webhook failures</option></select></label>
                    <label className='filter-search'><span>Search</span><input type='search' value={search} maxLength={200} placeholder='Job, execution, delivery, or reason' onChange={event => setSearch(event.target.value)} /></label>
                    <label><span>From</span><input type='date' value={from} onChange={event => setFrom(event.target.value)} /></label>
                    <label><span>To</span><input type='date' value={to} min={from || undefined} onChange={event => setTo(event.target.value)} /></label>
                    <button className='button button-primary'>Apply</button>
                    <button className='button button-quiet' type='button' onClick={() => navigate(attentionPath({ state: filters.state, page: 1, limit: filters.limit }))}>Clear</button>
                </form>
                <div
                    ref={splitRef}
                    className={'incident-split ' + (resizingPreview ? 'is-resizing' : '')}
                    style={{ '--incident-preview-width': `${previewWidth}px` } as CSSProperties}
                ><div className='table-wrap incident-table-pane'>
                    <table>
                        <colgroup>{props.canManage && <col className="incident-col-select" />}<col className="incident-col-severity" /><col className="incident-col-source" /><col className="incident-col-reason" /><col className="incident-col-occurred" /><col className="incident-col-state" /></colgroup>
                        <thead><tr>{props.canManage && <th>Select</th>}<th>Severity</th><th>Job and source</th><th>Reason</th><th>Occurred</th><th>State</th></tr></thead>
                        <tbody>
                            {items.map(item => (
                                <tr key={item.attentionId} className={'clickable-row ' + (activeId === item.attentionId ? 'active' : '')} onClick={() => setActiveId(item.attentionId)} onDoubleClick={() => props.onOpen(item.attentionId)}>
                                    {props.canManage && <td><input type="checkbox" checked={selected.has(item.attentionId)} onClick={event => event.stopPropagation()} onChange={event => setSelected(current => { const next = new Set(current); if (event.target.checked) next.add(item.attentionId); else next.delete(item.attentionId); return next; })} /></td>}
                                    <td><span className={'severity severity-' + item.severity}>{item.severity}</span><small>{item.kind === 'execution_failure' ? 'Execution' : 'Webhook'} · {item.occurrenceCount}×</small></td>
                                    <td><button className='row-link' onClick={event => { event.stopPropagation(); setActiveId(item.attentionId); }}>{item.jobId}</button><small>{item.sourceId}</small></td>
                                    <td className='reason-cell'>{item.reason}</td>
                                    <td className="occurred-cell" title={new Date(item.occurredAt).toLocaleString()}>{formatRelativeTime(item.occurredAt)}</td>
                                    <td><span className={'status status-' + item.state}><i aria-hidden='true' />{titleCase(item.state)}</span></td>
                                </tr>
                            ))}
                            {!loading && items.length === 0 && <tr><td colSpan={props.canManage ? 6 : 5} className='empty'>No {filters.state} attention items match this view.</td></tr>}
                        </tbody>
                    </table>
                </div><div
                    className="incident-resizer"
                    role="separator"
                    aria-label="Resize incident details"
                    aria-orientation="vertical"
                    aria-valuemin={INCIDENT_PREVIEW_MIN_WIDTH}
                    aria-valuemax={Math.max(INCIDENT_PREVIEW_MIN_WIDTH, (splitRef.current?.clientWidth ?? 1000) - 680 - INCIDENT_RESIZER_WIDTH)}
                    aria-valuenow={previewWidth}
                    tabIndex={0}
                    title="Drag to resize incident details"
                    onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); resizingPreviewRef.current = true; setResizingPreview(true); resizePreviewFromPointer(event, false); }}
                    onPointerMove={event => { if (resizingPreviewRef.current) resizePreviewFromPointer(event, false); }}
                    onPointerUp={event => { resizePreviewFromPointer(event, true); resizingPreviewRef.current = false; setResizingPreview(false); event.currentTarget.releasePointerCapture(event.pointerId); }}
                    onPointerCancel={() => { resizingPreviewRef.current = false; setResizingPreview(false); }}
                    onKeyDown={resizePreviewFromKeyboard}
                ><span aria-hidden="true" /></div><IncidentPreview item={items.find(item => item.attentionId === activeId)} onOpen={props.onOpen} /></div>
                <div className='page-size-row'>
                    <label><span>Rows per page</span><select value={filters.limit} onChange={event => navigate(attentionPath({ ...filters, page: 1, limit: Number(event.target.value) as 25 | 50 | 100 }))}><option value={25}>25</option><option value={50}>50</option><option value={100}>100</option></select></label>
                </div>
                <Pagination page={filters.page} pageSize={filters.limit} total={total} totalPages={totalPages} loading={loading} onPage={page => navigate(attentionPath({ ...filters, page }))} />
            </section>
        </>
    );
}

function IncidentPreview(props: { item?: AttentionItem; onOpen: (id: string) => void }) {
    if (props.item === undefined) return <aside className="incident-preview empty"><p>Select an incident. Use ↑/↓ to move and Enter to open details.</p></aside>;
    const item = props.item;
    const latestActivityAt = latestAttentionActivityAt(item);
    return <aside className="incident-preview"><p className="eyebrow">{item.kind.replace('_', ' ')}</p><h2>{item.jobId}</h2><span className={'severity severity-' + item.severity}>{item.severity}</span><p>{item.reason}</p><dl><div><dt>State</dt><dd>{titleCase(item.state)}</dd></div><div><dt>Assignment</dt><dd>{item.assigneeUserId ?? 'Unassigned'}</dd></div><div><dt>Occurrences</dt><dd>{item.occurrenceCount}</dd></div><div><dt>Latest activity</dt><dd title={new Date(latestActivityAt).toLocaleString()}>{formatRelativeTime(latestActivityAt)}</dd></div></dl><code>{item.executionId}</code><button className="button button-primary" onClick={() => props.onOpen(item.attentionId)}>Open timeline & actions</button></aside>;
}
