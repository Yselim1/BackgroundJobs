import { useCallback, useEffect, useMemo, useState } from 'react';
import { downloadAuditExport, getAuditEvent, getAuditEvents } from '../api';
import { calendarRangeToApi } from '../dateFilters';
import { formatRelativeTime, titleCase } from '../format';
import { Pagination } from '../PageControls';
import { pageSize as parsePageSize, positivePage } from '../pagination';
import { routeSearchParams, setRouteQuery } from '../routes';
import type { AuditEvent, AuditFilters } from '../types';
import { useModalBehavior } from '../useModalBehavior';

interface AuditPageProps {
    liveVersion: number;
    onError: (message: string | undefined) => void;
}

export function AuditPage(props: AuditPageProps) {
    const initial = useMemo(() => routeSearchParams(), []);
    const [action, setAction] = useState(initial.get('action') ?? '');
    const [actorType, setActorType] = useState<AuditEvent['actorType'] | 'all'>(
        (initial.get('actorType') as AuditEvent['actorType'] | null) ?? 'all'
    );
    const [actorLabel, setActorLabel] = useState(initial.get('actorLabel') ?? '');
    const [resource, setResource] = useState(initial.get('resource') ?? '');
    const [outcome, setOutcome] = useState<AuditEvent['outcome'] | 'all'>(
        (initial.get('outcome') as AuditEvent['outcome'] | null) ?? 'all'
    );
    const [from, setFrom] = useState(initial.get('from') ?? '');
    const [to, setTo] = useState(initial.get('to') ?? '');
    const [page, setPage] = useState(() => positivePage(initial.get('page')));
    const [pageSize, setPageSize] = useState<25 | 50 | 100>(() => parsePageSize(initial.get('pageSize')));
    const [items, setItems] = useState<AuditEvent[]>([]);
    const [total, setTotal] = useState(0);
    const [totalPages, setTotalPages] = useState(0);
    const [selected, setSelected] = useState<AuditEvent>();
    const [loading, setLoading] = useState(false);
    const [exporting, setExporting] = useState<'csv' | 'json'>();

    const filters = useCallback((): AuditFilters => ({
        ...(action.trim().length === 0 ? {} : { action: action.trim() }),
        ...(actorType === 'all' ? {} : { actorType }),
        ...(actorLabel.trim().length === 0 ? {} : { actorLabel: actorLabel.trim() }),
        ...(resource.trim().length === 0 ? {} : { resource: resource.trim() }),
        ...(outcome === 'all' ? {} : { outcome }),
        ...calendarRangeToApi(from, to)
    }), [action, actorLabel, actorType, from, outcome, resource, to]);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const result = await getAuditEvents({ ...filters(), page, limit: pageSize });
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
    }, [filters, page, pageSize, props.onError]);

    useEffect(() => {
        setRouteQuery('/audit', {
            action, actorType, actorLabel, resource, outcome, from, to,
            page: String(page), pageSize: String(pageSize)
        });
    }, [action, actorLabel, actorType, from, outcome, page, pageSize, resource, to]);

    useEffect(() => { void load(); }, [load, props.liveVersion]);

    const reset = (change: () => void) => {
        setPage(1);
        change();
    };

    const openEvent = async (auditId: string) => {
        try {
            setSelected(await getAuditEvent(auditId));
            props.onError(undefined);
        } catch (caught) {
            props.onError(caught instanceof Error ? caught.message : String(caught));
        }
    };

    const exportEvents = async (format: 'csv' | 'json') => {
        if (total > 10_000 && !window.confirm(
            `${total.toLocaleString()} events match. The export is capped at the newest 10,000 records. Continue?`
        )) return;
        setExporting(format);
        try {
            const result = await downloadAuditExport(filters(), format);
            const url = URL.createObjectURL(result.blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = result.filename;
            link.click();
            URL.revokeObjectURL(url);
            props.onError(undefined);
        } catch (caught) {
            props.onError(caught instanceof Error ? caught.message : String(caught));
        } finally {
            setExporting(undefined);
        }
    };

    return (
        <section className="audit-page">
            <div className="page-heading">
                <div>
                    <p className="eyebrow">Append-only history</p>
                    <h1>Audit</h1>
                    <p>Trace security-sensitive actions, actors, resources, and request context.</p>
                </div>
                <div className="audit-export-actions">
                    <button className="button button-quiet" disabled={exporting !== undefined} onClick={() => void exportEvents('csv')}>Export CSV</button>
                    <button className="button button-quiet" disabled={exporting !== undefined} onClick={() => void exportEvents('json')}>Export JSON</button>
                </div>
            </div>
            <div className="audit-filters">
                <Filter label="Action"><input value={action} placeholder="Search actions" onChange={event => reset(() => setAction(event.target.value))} /></Filter>
                <Filter label="Actor type">
                    <select value={actorType} onChange={event => reset(() => setActorType(event.target.value as typeof actorType))}>
                        <option value="all">All actor types</option>
                        <option value="user">User</option>
                        <option value="api_token">API token</option>
                        <option value="system">System</option>
                        <option value="anonymous">Anonymous</option>
                    </select>
                </Filter>
                <Filter label="Actor"><input value={actorLabel} placeholder="Search actor labels" onChange={event => reset(() => setActorLabel(event.target.value))} /></Filter>
                <Filter label="Resource"><input value={resource} placeholder="Type or identifier" onChange={event => reset(() => setResource(event.target.value))} /></Filter>
                <Filter label="Outcome">
                    <select value={outcome} onChange={event => reset(() => setOutcome(event.target.value as typeof outcome))}>
                        <option value="all">All outcomes</option>
                        <option value="success">Success</option>
                        <option value="failure">Failure</option>
                    </select>
                </Filter>
                <Filter label="From"><input type="date" value={from} onChange={event => reset(() => setFrom(event.target.value))} /></Filter>
                <Filter label="To"><input type="date" value={to} onChange={event => reset(() => setTo(event.target.value))} /></Filter>
            </div>
            <div className="panel audit-panel table-wrap">
                <table>
                    <thead><tr><th>Time</th><th>Action</th><th>Actor</th><th>Resource</th><th>Outcome</th><th>HTTP</th></tr></thead>
                    <tbody>
                        {items.map(event => (
                            <tr key={event.auditId}>
                                <td>{formatRelativeTime(event.createdAt)}</td>
                                <td><button className="row-link" onClick={() => void openEvent(event.auditId)}>{event.action}</button><small>{event.requestId}</small></td>
                                <td>{event.actorLabel}<small>{titleCase(event.actorType)}</small></td>
                                <td>{event.resourceId ?? event.resourceType ?? 'System'}<small>{event.resourceId === null ? '' : event.resourceType}</small></td>
                                <td><Status status={event.outcome} /></td>
                                <td>{event.statusCode}</td>
                            </tr>
                        ))}
                        {!loading && items.length === 0 && <tr><td className="empty" colSpan={6}>No audit events match these filters.</td></tr>}
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
            <AuditDrawer event={selected} onClose={() => setSelected(undefined)} />
        </section>
    );
}

function Filter(props: { label: string; children: React.ReactNode }) {
    return <label className="log-filter"><span>{props.label}</span>{props.children}</label>;
}

function Status(props: { status: string }) {
    return <span className={'status status-' + props.status}><i aria-hidden="true" />{titleCase(props.status)}</span>;
}

function AuditDrawer(props: { event?: AuditEvent; onClose: () => void }) {
    useModalBehavior(props.event !== undefined, props.onClose);
    const event = props.event;
    return (
        <>
            <button
                className={'drawer-backdrop ' + (event === undefined ? '' : 'visible')}
                onClick={props.onClose}
                aria-label="Close audit event details"
                tabIndex={event === undefined ? -1 : 0}
            />
            <aside
                className={'drawer audit-drawer ' + (event === undefined ? '' : 'open')}
                aria-hidden={event === undefined}
                aria-modal="true"
                aria-labelledby="audit-modal-title"
                role="dialog"
            >
                {event !== undefined && (
                    <>
                        <div className="drawer-head">
                            <div>
                                <p className="eyebrow">Audit event {event.auditId}</p>
                                <h2 id="audit-modal-title">{event.action}</h2>
                                <code>{event.requestId}</code>
                            </div>
                            <button className="close" onClick={props.onClose} aria-label="Close">×</button>
                        </div>
                        <div className="drawer-summary">
                            <Status status={event.outcome} />
                            <span>HTTP {event.statusCode}</span>
                            <span>{new Date(event.createdAt).toLocaleString()}</span>
                        </div>
                        <div className="audit-detail-grid">
                            <Fact label="Timestamp" value={new Date(event.createdAt).toLocaleString()} />
                            <Fact label="Request ID" value={event.requestId} />
                            <Fact label="Actor" value={event.actorLabel} note={titleCase(event.actorType)} />
                            <Fact label="Actor user ID" value={event.actorUserId ?? 'None'} />
                            <Fact label="Resource type" value={event.resourceType ?? 'None'} />
                            <Fact label="Resource ID" value={event.resourceId ?? 'None'} />
                            <Fact label="IP address" value={event.ipAddress ?? 'Not recorded'} />
                            <Fact label="User agent" value={event.userAgent ?? 'Not recorded'} />
                        </div>
                        <section className="audit-metadata">
                            <h3>Metadata</h3>
                            <pre>{JSON.stringify(event.metadata, null, 2)}</pre>
                        </section>
                    </>
                )}
            </aside>
        </>
    );
}

function Fact(props: { label: string; value: string; note?: string }) {
    return (
        <div>
            <span>{props.label}</span>
            <strong>{props.value}</strong>
            {props.note !== undefined && <small>{props.note}</small>}
        </div>
    );
}
