import { useCallback, useEffect, useState } from 'react';
import { drainWorker, getQueues, getWorkers, resumeWorker } from '../api';
import { formatRelativeTime, titleCase } from '../format';
import type { QueueSummary, WorkerInstance } from '../types';

export function WorkersPage(props: { canManage: boolean; onError: (message: string | undefined) => void }) {
    const [workers, setWorkers] = useState<WorkerInstance[]>([]);
    const [queues, setQueues] = useState<QueueSummary[]>([]);
    const [busy, setBusy] = useState<string>();
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
            {queues.map(queue => <article className="panel queue-card" key={queue.name}><span>Queue</span><h2>{queue.name}</h2><div><strong>{queue.queued}</strong> queued · <strong>{queue.running}</strong> running</div><small>{queue.workers} workers · capacity {queue.capacity}</small></article>)}
        </section>
        <section className="panel"><div className="panel-heading"><div><p className="eyebrow">Registered processes</p><h2>Worker fleet</h2></div><span>{workers.length} records</span></div>
            <div className="table-wrap"><table><thead><tr><th>Worker</th><th>State</th><th>Queues</th><th>Load</th><th>Heartbeat</th>{props.canManage && <th>Action</th>}</tr></thead><tbody>
                {workers.map(worker => <tr key={worker.workerId}><td><strong>{worker.name}</strong><small className="table-subtle">{worker.workerId}</small></td><td><span className={'status status-' + worker.state}><i />{titleCase(worker.state)}</span></td><td>{worker.queues.map(queue => <code key={queue}>{queue}</code>)}</td><td>{worker.running} / {worker.concurrency}</td><td>{formatRelativeTime(worker.lastHeartbeatAt)}</td>{props.canManage && <td><button className="button button-quiet" disabled={busy === worker.workerId || worker.state === 'offline' || worker.state === 'stopped'} onClick={() => void change(worker)}>{worker.desiredState === 'accepting' ? 'Drain' : 'Resume'}</button></td>}</tr>)}
                {workers.length === 0 && <tr><td colSpan={props.canManage ? 6 : 5} className="empty">No workers have registered.</td></tr>}
            </tbody></table></div>
        </section>
    </>;
}
