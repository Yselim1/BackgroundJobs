import { useEffect, useMemo, useState } from 'react';
import type { FocusEvent, PointerEvent } from 'react';
import { getActivity } from './api';
import { activityBucketRange } from './dateFilters';
import { formatDuration } from './format';
import type { ActivityBucket, PlatformActivity } from './types';

function bucketLabel(bucket: ActivityBucket) {
    return new Date(bucket.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

interface HoverCardPosition { left: number; top: number }

function hoverCardPosition(clientX: number, clientY: number): HoverCardPosition {
    const gap = 14;
    const edge = 10;
    const width = Math.min(250, window.innerWidth - edge * 2);
    const estimatedHeight = 205;
    const left = clientX + gap + width <= window.innerWidth - edge ? clientX + gap : clientX - width - gap;
    return {
        left: Math.max(edge, Math.min(left, window.innerWidth - width - edge)),
        top: Math.max(edge, Math.min(clientY - estimatedHeight / 2, window.innerHeight - estimatedHeight - edge))
    };
}

function ActivityHoverCard({ bucket, position }: { bucket: ActivityBucket; position: HoverCardPosition }) {
    const total = Math.max(1, bucket.requested);
    const rows = [
        { key: 'requested', label: 'Requested', value: bucket.requested },
        { key: 'successful', label: 'Successful', value: bucket.successful },
        { key: 'failed', label: 'Failed', value: bucket.failed }
    ];
    return <aside className="activity-hover-card" style={position} aria-hidden="true">
        <header><strong>{bucketLabel(bucket)}</strong><span>{bucket.requested === 0 ? 'No executions' : `${bucket.requested} total`}</span></header>
        <div className="activity-distribution">
            {rows.map(row => <div className={`distribution-row distribution-${row.key}`} key={row.key}>
                <span><i />{row.label}</span><strong>{row.value}</strong>
                <div><b style={{ width: `${row.value === 0 ? 0 : Math.max(4, row.value / total * 100)}%` }} /></div>
            </div>)}
        </div>
        <footer><span><small>Typical duration</small><strong>{formatDuration(bucket.p50DurationMs)}</strong></span><span><small>95% finish within</small><strong>{formatDuration(bucket.p95DurationMs)}</strong></span><span><small>Average queue wait</small><strong>{formatDuration(bucket.averageQueueDelayMs)}</strong></span></footer>
    </aside>;
}

export function ActivityChart(props: { onError: (message?: string) => void }) {
    const [windowSize, setWindowSize] = useState<'6h' | '24h' | '7d'>('24h');
    const [activity, setActivity] = useState<PlatformActivity>();
    const [loading, setLoading] = useState(true);
    const [hovered, setHovered] = useState<{ bucketAt: string; position: HoverCardPosition }>();
    useEffect(() => { setLoading(true); void getActivity(windowSize).then(value => { setActivity(value); props.onError(undefined); }).catch(error => props.onError(error instanceof Error ? error.message : String(error))).finally(() => setLoading(false)); }, [windowSize]);
    const max = useMemo(() => Math.max(1, ...(activity?.buckets.map(bucket => bucket.requested) ?? [1])), [activity]);
    const activeBucket = activity?.buckets.find(bucket => bucket.at === hovered?.bucketAt);
    return <section className="panel activity-panel"><div className="panel-heading"><div><p className="eyebrow">Private operational activity</p><h2>Execution health</h2></div><div className="window-switcher">{(['6h', '24h', '7d'] as const).map(value => <button className={windowSize === value ? 'active' : ''} key={value} onClick={() => setWindowSize(value)}>{value}</button>)}</div></div>
        {loading && activity === undefined ? <div className="chart-skeleton" aria-label="Loading activity" /> : <div className="activity-chart" role="group" aria-label={`Requested, successful, and failed executions over ${windowSize}`}>
            {activeBucket !== undefined && hovered !== undefined && <ActivityHoverCard bucket={activeBucket} position={hovered.position} />}
            {activity?.buckets.map(bucket => {
                const exactRange = activityBucketRange(bucket.at, activity.bucketMs, activity.startsAt, activity.generatedAt);
                const logsQuery = new URLSearchParams({ fromTs: exactRange.from, toTs: exactRange.to });
                const label = `${bucketLabel(bucket)} · ${bucket.requested} requested · ${bucket.successful} successful · ${bucket.failed} failed · typical duration ${formatDuration(bucket.p50DurationMs)} · 95% finish within ${formatDuration(bucket.p95DurationMs)} · average queue wait ${formatDuration(bucket.averageQueueDelayMs)}`;
                const contents = <><i style={{ height: `${bucket.requested / max * 100}%` }} /><b style={{ height: `${bucket.successful / max * 100}%` }} /><em style={{ height: `${bucket.failed / max * 100}%` }} /></>;
                const showAtPointer = (event: PointerEvent<HTMLElement>) => setHovered({ bucketAt: bucket.at, position: hoverCardPosition(event.clientX, event.clientY) });
                const showAtElement = (event: FocusEvent<HTMLElement>) => { const rect = event.currentTarget.getBoundingClientRect(); setHovered({ bucketAt: bucket.at, position: hoverCardPosition(rect.right, rect.top + rect.height / 2) }); };
                const interactionProps = { onPointerEnter: showAtPointer, onPointerMove: showAtPointer, onPointerLeave: () => setHovered(undefined), onFocus: showAtElement, onBlur: () => setHovered(undefined) };
                return bucket.requested === 0
                    ? <span key={bucket.at} className="activity-bar activity-bar-empty" tabIndex={0} aria-label={label} {...interactionProps}>{contents}</span>
                    : <a key={bucket.at} href={`/logs?${logsQuery.toString()}`} className="activity-bar" aria-label={`${label}. Open logs for this exact interval.`} {...interactionProps}>{contents}</a>;
            })}
        </div>}
        <div className="chart-legend"><span><i className="requested" />Requested</span><span><i className="successful" />Successful</span><span><i className="failed" />Failed</span><small>Calculated on demand from execution rows · {activity === undefined ? '' : Math.round(activity.bucketMs / 60000) + ' minute buckets'}</small></div>
    </section>;
}
