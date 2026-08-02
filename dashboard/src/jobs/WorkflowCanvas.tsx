import { useEffect, useMemo, useState } from 'react';
import {
    Background,
    Controls,
    Handle,
    Position,
    ReactFlow,
    useEdgesState,
    useNodesState,
    type Connection,
    type Edge,
    type Node,
    type NodeProps
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { ValidationIssue } from '../types';
import type { StepForm } from './jobForm';

type StepNode = Node<{ label: string; executor: string; issues: string[] }, 'step'>;
type Props = { steps: StepForm[]; secretNames: string[]; issues: ValidationIssue[]; onChange: (steps: StepForm[]) => void; onSelected: (id?: string) => void };

export function WorkflowCanvas(props: Props) {
    const layout = useMemo(() => autoLayout(props.steps, props.issues), [props.issues, props.steps]);
    const [nodes, setNodes, onNodesChange] = useNodesState<StepNode>(layout.nodes);
    const [edges, setEdges, onEdgesChange] = useEdgesState(layout.edges);
    const [selectedKey, setSelectedKey] = useState<string>();
    const [error, setError] = useState<string>();
    useEffect(() => { setNodes(layout.nodes); setEdges(layout.edges); }, [layout, setEdges, setNodes]);
    const selected = props.steps.find(step => step.key === selectedKey);
    const update = (patch: Partial<StepForm>) => selected && props.onChange(props.steps.map(step => step.key === selected.key ? { ...step, ...patch } : step));
    const connect = (connection: Connection) => {
        const source = props.steps.find(step => step.key === connection.source);
        const target = props.steps.find(step => step.key === connection.target);
        if (!source || !target) return;
        const invalid = invalidConnection(props.steps, source.id, target.id);
        if (invalid) { setError(invalid); return; }
        props.onChange(props.steps.map(step => step.key === target.key ? { ...step, dependencies: [...dependencies(step), source.id].join(', ') } : step));
        setError(undefined);
    };
    const remove = () => {
        if (!selected || props.steps.length === 1) return;
        props.onChange(props.steps.filter(step => step.key !== selected.key).map(step => ({ ...step, dependencies: dependencies(step).filter(id => id !== selected.id).join(', ') })));
        setSelectedKey(undefined);
        props.onSelected(undefined);
    };
    const duplicate = () => selected && props.onChange([...props.steps, {
        ...selected,
        key: `${selected.key}-copy-${props.steps.length}`,
        id: `${selected.id || 'step'}-copy`,
        name: `${selected.name || 'Step'} copy`
    }]);
    const deleteEdges = (removed: Edge[]) => {
        const removedIds = new Set(removed.map(edge => edge.id));
        props.onChange(props.steps.map(step => ({
            ...step,
            dependencies: dependencies(step).filter(dependency => {
                const source = props.steps.find(candidate => candidate.id === dependency);
                return source === undefined || !removedIds.has(`${source.key}->${step.key}`);
            }).join(', ')
        })));
    };
    const reconnect = (oldEdge: Edge, connection: Connection) => {
        const oldSourceId = props.steps.find(candidate => candidate.key === oldEdge.source)?.id;
        const withoutOld = props.steps.map(step => step.key === oldEdge.target
            ? { ...step, dependencies: dependencies(step).filter(id => id !== oldSourceId).join(', ') }
            : step);
        const source = withoutOld.find(step => step.key === connection.source);
        const target = withoutOld.find(step => step.key === connection.target);
        if (!source || !target) return;
        const invalid = invalidConnection(withoutOld, source.id, target.id);
        if (invalid) { setError(invalid); return; }
        props.onChange(withoutOld.map(step => step.key === target.key
            ? { ...step, dependencies: [...dependencies(step), source.id].join(', ') }
            : step));
        setError(undefined);
    };
    return (
        <div className="dag-authoring">
            <div className="dag-toolbar">
                <span>Definition-driven layout · positions are not saved</span>
                <button type="button" onClick={duplicate} disabled={!selected}>Duplicate</button>
                <button type="button" onClick={remove} disabled={!selected || props.steps.length === 1}>Remove</button>
            </div>
            {error && <div className="inline-error" role="alert">{error}</div>}
            <div className="dag-workspace">
                <div className="dag-canvas">
                    <ReactFlow
                        nodes={nodes}
                        edges={edges}
                        nodeTypes={{ step: StepCard }}
                        onNodesChange={onNodesChange}
                        onEdgesChange={onEdgesChange}
                        onEdgesDelete={deleteEdges}
                        onConnect={connect}
                        onReconnect={reconnect}
                        fitView
                        onNodeClick={(_event, node) => {
                            setSelectedKey(node.id);
                            props.onSelected(props.steps.find(step => step.key === node.id)?.id || undefined);
                        }}
                        onPaneClick={() => { setSelectedKey(undefined); props.onSelected(undefined); }}
                    >
                        <Background />
                        <Controls />
                    </ReactFlow>
                </div>
                <Inspector step={selected} issues={selected === undefined ? [] : issuesForStep(props.issues, props.steps.indexOf(selected))} secrets={props.secretNames} onChange={update} />
            </div>
        </div>
    );
}

function Inspector(props: { step?: StepForm; issues: string[]; secrets: string[]; onChange: (patch: Partial<StepForm>) => void }) {
    if (!props.step) return <aside className="node-inspector"><p>Select a node to inspect parameters, retry, conditions, fan-out, timeout, and replay safety.</p></aside>;
    const suggestions = ['input.', ...dependencies(props.step).map(id => `${id}.`), 'item', 'index', ...props.secrets.map(name => `secrets.${name}`)];
    return <aside className="node-inspector"><p className="eyebrow">Node inspector</p><h3>{props.step.name || props.step.id}</h3>
        {props.issues.length > 0 && <div className="node-issues" role="alert">{props.issues.map(issue => <small key={issue}>{issue}</small>)}</div>}
        <label><span>Executor parameters</span><textarea className="code-input" rows={7} value={props.step.params} onChange={event => props.onChange({ params: event.target.value })} /></label>
        <label className="replay-safe-control"><input type="checkbox" checked={props.step.replaySafe} onChange={event => props.onChange({ replaySafe: event.target.checked })} />Replay safe</label>
        <label><span>Retry · conditions · fan-out · timeout</span><textarea className="code-input" rows={7} value={props.step.advanced} onChange={event => props.onChange({ advanced: event.target.value })} /></label>
        <div className="expression-suggestions">{suggestions.map(item => <button type="button" key={item} onClick={() => void navigator.clipboard.writeText(`{{${item}}}`)}>{item}</button>)}</div>
    </aside>;
}

function StepCard({ data, selected }: NodeProps<StepNode>) {
    return <div className={'dag-node ' + (selected ? 'selected ' : '') + (data.issues.length > 0 ? 'invalid' : '')} title={data.issues.join('\n')}><Handle type="target" position={Position.Left} /><strong>{data.label}</strong><small>{data.executor}{data.issues.length > 0 ? ` · ${data.issues.length} issue${data.issues.length === 1 ? '' : 's'}` : ''}</small><Handle type="source" position={Position.Right} /></div>;
}

function dependencies(step: StepForm): string[] {
    return step.dependencies.split(',').map(value => value.trim()).filter(Boolean);
}

function autoLayout(steps: StepForm[], issues: ValidationIssue[]): { nodes: StepNode[]; edges: Edge[] } {
    const byId = new Map(steps.filter(step => step.id).map(step => [step.id, step]));
    const depths = new Map<string, number>();
    const depth = (step: StepForm, visiting = new Set<string>()): number => {
        if (depths.has(step.key)) return depths.get(step.key)!;
        if (visiting.has(step.key)) return 0;
        visiting.add(step.key);
        const result = dependencies(step).reduce((max, id) => Math.max(max, 1 + (byId.get(id) ? depth(byId.get(id)!, new Set(visiting)) : 0)), 0);
        depths.set(step.key, result);
        return result;
    };
    const rows = new Map<number, number>();
    const nodes = steps.map((step, index) => {
        const column = depth(step);
        const row = rows.get(column) ?? 0;
        rows.set(column, row + 1);
        return { id: step.key, type: 'step' as const, position: { x: column * 250, y: row * 120 }, data: { label: step.name || step.id || 'Untitled step', executor: step.type, issues: issuesForStep(issues, index) } };
    });
    const edges = steps.flatMap((step, index) => dependencies(step).flatMap(id => byId.get(id)
        ? [{ id: `${byId.get(id)!.key}->${step.key}`, source: byId.get(id)!.key, target: step.key, type: 'smoothstep',
            className: issues.some(issue => issue.path.startsWith(`STEPS[${index}]`) && issue.path.includes('DEPENDS_ON')) ? 'invalid-edge' : '' }]
        : []));
    return { nodes, edges };
}

function issuesForStep(issues: ValidationIssue[], index: number): string[] {
    const prefix = `STEPS[${index}]`;
    return issues.filter(issue => issue.path === prefix || issue.path.startsWith(prefix + '.'))
        .map(issue => `${issue.path.slice(prefix.length).replace(/^\./u, '') || 'Step'}: ${issue.message}`);
}

function invalidConnection(steps: StepForm[], source: string, target: string): string | undefined {
    if (!source || !target) return 'Both nodes need step IDs before connecting.';
    if (source === target) return 'A step cannot depend on itself.';
    const targetStep = steps.find(step => step.id === target);
    if (!targetStep) return 'Target step was not found.';
    if (dependencies(targetStep).includes(source)) return 'That dependency already exists.';
    const graph = new Map(steps.map(step => [step.id, step.id === target ? [...dependencies(step), source] : dependencies(step)]));
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (id: string): boolean => {
        if (visiting.has(id)) return true;
        if (visited.has(id)) return false;
        visiting.add(id);
        for (const dependency of graph.get(id) ?? []) if (visit(dependency)) return true;
        visiting.delete(id);
        visited.add(id);
        return false;
    };
    return [...graph.keys()].some(visit) ? 'That connection would create a cycle.' : undefined;
}
