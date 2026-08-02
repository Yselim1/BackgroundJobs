import { useCallback, useEffect, useState } from 'react';
import { drainWorker, getQueueDetail, getQueues, getWorkers, resumeWorker, updateQueuePolicy } from '../api';
import { formatRelativeTime, titleCase } from '../format';
import type { QueueDetail, QueueSummary, WorkerInstance } from '../types';

export function WorkersPage(props: { canManage: boolean; onError: (message: string | undefined) => void }) {
    const [workers, setWorkers] = useState<WorkerInstance[]>([]);
    const [queues, setQueues] = useState<QueueSummary[]>([]);
    const [busy, setBusy] = useState<string>();
    const [selectedQueue, setSelectedQueue] = useState<QueueDetail>();
    const load = useCallback(async () => {
        try {
            const [nextWorkers, nextQueues] = await Promise.all([getWorkers(), getQueues()]);
            setWorkers(nextWorkers); setQueues(nextQueues); props.onError(undefined);
        } catch (error) { props.onError(error instanceof Error ? error.message : String(error)); }
    }, [props.onError]);
    useEffect(() => {
        void load();
        const timer = window.setInterval(() => void load(), 5_000);
        return () => window.clearInterval(timer);
    }, [load]);
    const change = async (worker: WorkerInstance) => {
        setBusy(worker.workerId);
        try {
            if (worker.desiredState === 'accepting') await drainWorker(worker.workerId);
            else await resumeWorker(worker.workerId);
            await load();
        } catch (error) { props.onError(error instanceof Error ? error.message : String(error)); }
        finally { setBusy(undefined); }
    };
    return <>
        <section className="page-heading"><div><p className="eyebrow">Execution fleet</p><h1>Workers & queues</h1><p>Inspect live capacity, queue backlog, worker leases, and drain state.</p></div><button className="button button-quiet" onClick={() => void load()}>Refresh</button></section>
        <section className="queue-grid">
            {queues.map(queue => <button className="panel queue-card" key={queue.name} onClick={() => void getQueueDetail(queue.name).then(setSelectedQueue).catch(error => props.onError(error instanceof Error ? error.message : String(error)))}><span>Queue</span><h2>{queue.name}</h2><div><strong>{queue.queued}</strong> queued · <strong>{queue.running}</strong> running</div><small>{queue.workers} workers · capacity {queue.capacity}</small></button>)}
        </section>
        {selectedQueue !== undefined && <QueuePolicyPanel detail={selectedQueue} canManage={props.canManage} onClose={() => setSelectedQueue(undefined)} onChanged={async () => { setSelectedQueue(await getQueueDetail(selectedQueue.name)); await load(); }} onError={props.onError} />}
        <section className="panel"><div className="panel-heading"><div><p className="eyebrow">Registered processes</p><h2>Worker fleet</h2></div><span>{workers.length} records</span></div>
            <div className="table-wrap"><table><thead><tr><th>Worker</th><th>State</th><th>Queues</th><th>Load</th><th>Heartbeat</th>{props.canManage && <th>Action</th>}</tr></thead><tbody>
                {workers.map(worker => <tr key={worker.workerId}><td><strong>{worker.name}</strong><small className="table-subtle">{worker.workerId}</small></td><td><span className={'status status-' + worker.state}><i />{titleCase(worker.state)}</span></td><td>{worker.queues.map(queue => <code key={queue}>{queue}</code>)}</td><td>{worker.running} / {worker.concurrency}</td><td>{formatRelativeTime(worker.lastHeartbeatAt)}</td>{props.canManage && <td><button className="button button-quiet" disabled={busy === worker.workerId || worker.state === 'offline' || worker.state === 'stopped'} onClick={() => void change(worker)}>{worker.desiredState === 'accepting' ? 'Drain' : 'Resume'}</button></td>}</tr>)}
                {workers.length === 0 && <tr><td colSpan={props.canManage ? 6 : 5} className="empty">No workers have registered.</td></tr>}
            </tbody></table></div>
        </section>
    </>;
}

function QueuePolicyPanel(props: { detail: QueueDetail; canManage: boolean; onClose: () => void; onChanged: () => Promise<void>; onError: (message?: string) => void }) {
    const policy = props.detail.policy;
    const [paused, setPaused] = useState(policy.paused);
    const [maxRunning, setMaxRunning] = useState(policy.maxRunning?.toString() ?? '');
    const [maxStarts, setMaxStarts] = useState(policy.maxStarts?.toString() ?? '');
    const [intervalMs, setIntervalMs] = useState(policy.intervalMs?.toString() ?? '');
    const [busy, setBusy] = useState(false);
    const save = async () => {
        setBusy(true);
        try {
            await updateQueuePolicy(props.detail.name, { paused, maxRunning: maxRunning ? Number(maxRunning) : null, maxStarts: maxStarts ? Number(maxStarts) : null, intervalMs: intervalMs ? Number(intervalMs) : null }, policy.version);
            await props.onChanged(); props.onError(undefined);
        } catch (error) { props.onError(error instanceof Error ? error.message : String(error)); }
        finally { setBusy(false); }
    };
    return <section className="panel queue-detail"><div className="panel-heading"><div><p className="eyebrow">Queue drill-down</p><h2>{props.detail.name}</h2></div><button className="close" onClick={props.onClose}>×</button></div>
        <div className="queue-detail-grid"><article><span>Saturation</span><strong>{policy.paused ? 'Paused' : props.detail.saturation === null ? `${props.detail.running} running` : `${Math.round(props.detail.saturation * 100)}%`}</strong><small>Oldest queued {props.detail.oldestQueuedAgeMs === null ? '—' : Math.round(props.detail.oldestQueuedAgeMs / 1000) + 's'}</small></article><article><span>Subscribers</span><strong>{props.detail.subscribedWorkers.length}</strong><small>{props.detail.subscribedWorkers.map(worker => worker.name).join(', ') || 'No live workers'}</small></article><article><span>Affected jobs</span><strong>{props.detail.affectedJobs.length}</strong><small>{props.detail.affectedJobs.map(job => job.name).join(', ') || 'None'}</small></article></div>
        {props.canManage && <div className="queue-policy-form"><label><input type="checkbox" checked={paused} onChange={event => setPaused(event.target.checked)} />Pause new claims</label><label>Maximum running<input type="number" min="1" value={maxRunning} onChange={event => setMaxRunning(event.target.value)} placeholder="Unlimited" /></label><label>Max starts<input type="number" min="1" value={maxStarts} onChange={event => setMaxStarts(event.target.value)} placeholder="Unlimited" /></label><label>Interval ms<input type="number" min="1000" value={intervalMs} onChange={event => setIntervalMs(event.target.value)} placeholder="Disabled" /></label><button className="button button-primary" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save policy'}</button></div>}
        <h3>Recent executions</h3><div className="compact-executions">{props.detail.recentExecutions.map(execution => <a href={'/logs/' + execution.executionId} key={execution.executionId}><span>{execution.jobId}</span><strong>{execution.status}</strong><small>{formatRelativeTime(execution.requestedAt)}</small></a>)}</div>
    </section>;
}
