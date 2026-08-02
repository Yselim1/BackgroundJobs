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
            <WorkflowVersionDiff before={previous?.definition} after={selected.definition} />
            <h4>Raw definition diff</h4>
            <pre className="json-diff">{diffJson(previous?.definition, selected.definition).map((line, index) => <code className={'diff-' + line.kind} key={index}>{line.kind === 'add' ? '+ ' : line.kind === 'remove' ? '- ' : '  '}{line.text}{'\n'}</code>)}</pre>
            {props.canWrite && selected.version !== props.job.version && <button className="button button-primary" disabled={busy} onClick={() => void rollback()}>{busy ? 'Rolling back…' : `Restore version ${selected.version}`}</button>}
        </aside>}</div>
    </section>;
}

function WorkflowVersionDiff(props: { before?: JobRevision['definition']; after: JobRevision['definition'] }) {
    const beforeSteps = new Map((props.before?.STEPS ?? []).map(step => [step.ID, step]));
    const afterSteps = new Map(props.after.STEPS.map(step => [step.ID, step]));
    const addedNodes = [...afterSteps.keys()].filter(id => !beforeSteps.has(id));
    const removedNodes = [...beforeSteps.keys()].filter(id => !afterSteps.has(id));
    const changedNodes = [...afterSteps.keys()].filter(id => beforeSteps.has(id))
        .map(id => ({ id, fields: changedPaths(beforeSteps.get(id), afterSteps.get(id)).filter(path => path !== 'ID') }))
        .filter(item => item.fields.length > 0);
    const beforeEdges = workflowEdges(props.before?.STEPS ?? []);
    const afterEdges = workflowEdges(props.after.STEPS);
    const addedEdges = [...afterEdges].filter(edge => !beforeEdges.has(edge));
    const removedEdges = [...beforeEdges].filter(edge => !afterEdges.has(edge));
    const jobFields = changedPaths(
        props.before === undefined ? {} : Object.fromEntries(Object.entries(props.before).filter(([key]) => key !== 'STEPS')),
        Object.fromEntries(Object.entries(props.after).filter(([key]) => key !== 'STEPS'))
    );
    const total = addedNodes.length + removedNodes.length + changedNodes.length + addedEdges.length + removedEdges.length + jobFields.length;
    return <div className="workflow-version-diff">
        <div className="version-change-summary"><span><strong>{addedNodes.length}</strong> nodes added</span><span><strong>{removedNodes.length}</strong> removed</span><span><strong>{changedNodes.length}</strong> changed</span><span><strong>{addedEdges.length + removedEdges.length}</strong> edge changes</span></div>
        {total === 0 ? <p className="empty">No workflow or field changes.</p> : <div className="version-change-groups">
            {(addedNodes.length > 0 || removedNodes.length > 0) && <section><h4>Nodes</h4>{addedNodes.map(id => <code className="change-add" key={'add-' + id}>+ {id}</code>)}{removedNodes.map(id => <code className="change-remove" key={'remove-' + id}>− {id}</code>)}</section>}
            {(addedEdges.length > 0 || removedEdges.length > 0) && <section><h4>Dependencies</h4>{addedEdges.map(edge => <code className="change-add" key={'add-' + edge}>+ {edge}</code>)}{removedEdges.map(edge => <code className="change-remove" key={'remove-' + edge}>− {edge}</code>)}</section>}
            {changedNodes.length > 0 && <section><h4>Step fields</h4>{changedNodes.map(item => <div key={item.id}><strong>{item.id}</strong><small>{item.fields.join(', ')}</small></div>)}</section>}
            {jobFields.length > 0 && <section><h4>Job fields</h4><small>{jobFields.join(', ')}</small></section>}
        </div>}
    </div>;
}

function workflowEdges(steps: JobRevision['definition']['STEPS']): Set<string> {
    return new Set(steps.flatMap(step => (step.DEPENDS_ON ?? []).map(dependency => `${dependency} → ${step.ID}`)));
}

export function changedPaths(before: unknown, after: unknown, prefix = ''): string[] {
    if (Object.is(before, after)) return [];
    const beforeRecord = asRecord(before);
    const afterRecord = asRecord(after);
    if (beforeRecord === undefined || afterRecord === undefined) return [prefix || 'definition'];
    const keys = new Set([...Object.keys(beforeRecord), ...Object.keys(afterRecord)]);
    return [...keys].flatMap(key => changedPaths(beforeRecord[key], afterRecord[key], prefix ? `${prefix}.${key}` : key));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
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
