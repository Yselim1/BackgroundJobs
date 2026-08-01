import { useEffect, useState } from 'react';
import { getJobVersion, getJobVersions, rollbackJob } from '../api';
import { formatRelativeTime, titleCase } from '../format';
import type { Job, JobRevision, JobRevisionSummary } from '../types';

export function JobVersionsPanel(props: { job: Job; canWrite: boolean; onChanged: () => Promise<void>; onError: (message: string | undefined) => void }) {
    const [items, setItems] = useState<JobRevisionSummary[]>([]);
    const [selected, setSelected] = useState<JobRevision>();
    const [previous, setPrevious] = useState<JobRevision>();
    const [busy, setBusy] = useState(false);
    const load = async () => {
        try { setItems((await getJobVersions(props.job.id)).items); props.onError(undefined); }
        catch (error) { props.onError(error instanceof Error ? error.message : String(error)); }
    };
    useEffect(() => { void load(); }, [props.job.id, props.job.version]);
    const inspect = async (version: number) => {
        try {
            const [revision, prior] = await Promise.all([
                getJobVersion(props.job.id, version),
                version > 1 ? getJobVersion(props.job.id, version - 1) : Promise.resolve(undefined)
            ]);
            setSelected(revision); setPrevious(prior); props.onError(undefined);
        } catch (error) { props.onError(error instanceof Error ? error.message : String(error)); }
    };
    const rollback = async () => {
        if (selected === undefined || !window.confirm(`Create a new revision from version ${selected.version}? The current active/inactive state will be preserved.`)) return;
        setBusy(true);
        try { await rollbackJob(props.job.id, selected.version, props.job.version); setSelected(undefined); await props.onChanged(); await load(); }
        catch (error) { props.onError(error instanceof Error ? error.message : String(error)); }
        finally { setBusy(false); }
    };
    return <section className="panel version-panel">
        <div className="panel-heading"><div><p className="eyebrow">Immutable history</p><h2>Versions</h2></div><span>Current v{props.job.version}</span></div>
        <div className="version-layout"><div className="table-wrap"><table><thead><tr><th>Version</th><th>Change</th><th>Actor</th><th>Created</th></tr></thead><tbody>
            {items.map(item => <tr className="clickable-row" key={item.version} onClick={() => void inspect(item.version)}><td><strong>v{item.version}</strong>{item.version === props.job.version && <small className="table-subtle">Current</small>}</td><td>{titleCase(item.changeType)}{item.restoredFromVersion !== null && <small className="table-subtle">from v{item.restoredFromVersion}</small>}</td><td>{item.createdBy.label}</td><td>{formatRelativeTime(item.createdAt)}</td></tr>)}
        </tbody></table></div>
        {selected !== undefined && <aside className="version-inspector"><div className="panel-heading"><div><h3>Version {selected.version}</h3><small>Compared with {previous === undefined ? 'an empty definition' : `version ${previous.version}`}</small></div><button className="close" onClick={() => setSelected(undefined)}>×</button></div>
            <pre className="json-diff">{diffJson(previous?.definition, selected.definition).map((line, index) => <code className={'diff-' + line.kind} key={index}>{line.kind === 'add' ? '+ ' : line.kind === 'remove' ? '- ' : '  '}{line.text}{'\n'}</code>)}</pre>
            {props.canWrite && selected.version !== props.job.version && <button className="button button-primary" disabled={busy} onClick={() => void rollback()}>{busy ? 'Rolling back…' : `Restore version ${selected.version}`}</button>}
        </aside>}</div>
    </section>;
}

export function diffJson(before: unknown, after: unknown): Array<{ kind: 'same' | 'add' | 'remove'; text: string }> {
    const left = before === undefined ? [] : JSON.stringify(before, null, 2).split('\n');
    const right = JSON.stringify(after, null, 2).split('\n');
    const table = Array.from({ length: left.length + 1 }, () => Array<number>(right.length + 1).fill(0));
    for (let i = left.length - 1; i >= 0; i--) for (let j = right.length - 1; j >= 0; j--) {
        table[i]![j] = left[i] === right[j] ? 1 + table[i + 1]![j + 1]! : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
    const result: Array<{ kind: 'same' | 'add' | 'remove'; text: string }> = [];
    let i = 0; let j = 0;
    while (i < left.length || j < right.length) {
        if (i < left.length && j < right.length && left[i] === right[j]) { result.push({ kind: 'same', text: left[i]! }); i++; j++; }
        else if (j < right.length && (i === left.length || table[i]![j + 1]! >= table[i + 1]![j]!)) { result.push({ kind: 'add', text: right[j++]! }); }
        else { result.push({ kind: 'remove', text: left[i++]! }); }
    }
    return result;
}
