import { useEffect, useMemo, useState } from 'react';
import { runJob, validateRunInput } from './api';
import type { Job } from './types';
import { useModalBehavior } from './useModalBehavior';

export function RunWorkbench(props: { job?: Job; onClose: () => void; onQueued: (executionId: string) => Promise<void> }) {
    useModalBehavior(props.job !== undefined, props.onClose);
    const initial = useMemo(() => structuredClone(props.job?.DEFAULT_INPUT ?? {}), [props.job?.id, props.job?.version]);
    const [input, setInput] = useState<Record<string, unknown>>(initial);
    const [raw, setRaw] = useState(() => JSON.stringify(initial, null, 2));
    const [mode, setMode] = useState<'form' | 'raw'>(props.job?.INPUT_SCHEMA === undefined ? 'raw' : 'form');
    const [errors, setErrors] = useState<string[]>([]);
    const [busy, setBusy] = useState(false);
    const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
    useEffect(() => {
        setInput(initial);
        setRaw(JSON.stringify(initial, null, 2));
        setMode(props.job?.INPUT_SCHEMA === undefined ? 'raw' : 'form');
        setErrors([]);
        setIdempotencyKey(crypto.randomUUID());
    }, [initial, props.job?.id, props.job?.INPUT_SCHEMA]);
    if (props.job === undefined) return null;
    const job = props.job;
    const schema = job.INPUT_SCHEMA;
    const properties = record(schema?.properties) ? schema.properties : {};
    const required = new Set(Array.isArray(schema?.required) ? schema.required.filter((item): item is string => typeof item === 'string') : []);
    const syncInput = (next: Record<string, unknown>) => { setInput(next); setRaw(JSON.stringify(next, null, 2)); setErrors([]); };
    const applyRaw = (): Record<string, unknown> | undefined => {
        try { const parsed = JSON.parse(raw) as unknown; if (!record(parsed)) throw new Error('Input must be a JSON object.'); setInput(parsed); return parsed; }
        catch (error) { setErrors([error instanceof Error ? error.message : String(error)]); return undefined; }
    };
    const queue = async () => {
        const candidate = mode === 'raw' ? applyRaw() : input;
        if (candidate === undefined) return;
        const local = localIssues(candidate, properties, required);
        if (local.length > 0) { setErrors(local); return; }
        setBusy(true);
        try {
            await validateRunInput(job.id, candidate, true);
            const queued = await runJob(job.id, candidate, idempotencyKey);
            await props.onQueued(queued.executionId);
            props.onClose();
        } catch (error) { setErrors([error instanceof Error ? error.message : String(error)]); }
        finally { setBusy(false); }
    };
    return <><button className="drawer-backdrop visible" onClick={props.onClose} aria-label="Close run workbench" /><aside className="run-workbench" role="dialog" aria-modal="true" aria-labelledby="run-workbench-title">
        <header><div><p className="eyebrow">Run workbench</p><h2 id="run-workbench-title">Queue {job.name}</h2><code>{job.id}</code></div><button className="close" onClick={props.onClose}>×</button></header>
        <div className="mode-tabs"><button className={mode === 'form' ? 'active' : ''} disabled={schema === undefined} onClick={() => setMode('form')}>Generated form</button><button className={mode === 'raw' ? 'active' : ''} onClick={() => { setRaw(JSON.stringify(input, null, 2)); setMode('raw'); }}>Raw JSON</button></div>
        {mode === 'form' ? <div className="generated-input-form">{Object.entries(properties).map(([name, definition]) => <SchemaField key={name} name={name} schema={record(definition) ? definition : {}} required={required.has(name)} value={input[name]} onChange={value => syncInput({ ...input, [name]: value })} />)}{Object.keys(properties).length === 0 && <p className="empty">This object schema has no declared properties. Use raw JSON for additional fields.</p>}</div>
            : <label className="raw-input"><span>Execution input</span><textarea className="code-input" rows={18} value={raw} onChange={event => { setRaw(event.target.value); setErrors([]); }} spellCheck={false} /></label>}
        {errors.length > 0 && <div className="validation-summary" role="alert"><strong>Input is not ready</strong><ul>{errors.map(error => <li key={error}>{error}</li>)}</ul></div>}
        <p className="muted-copy">Input is validated here and by the server. It is not saved in browser storage.</p>
        <footer><button className="button button-quiet" onClick={props.onClose}>Cancel</button><button className="button button-run" disabled={busy} onClick={() => void queue()}>{busy ? 'Validating…' : 'Queue execution'}</button></footer>
    </aside></>;
}

function SchemaField(props: { name: string; schema: Record<string, unknown>; required: boolean; value: unknown; onChange: (value: unknown) => void }) {
    const label = typeof props.schema.title === 'string' ? props.schema.title : props.name;
    const enumValues = Array.isArray(props.schema.enum) ? props.schema.enum : undefined;
    if (enumValues) return <label><span>{label}{props.required ? ' *' : ''}</span><select value={String(props.value ?? '')} onChange={event => props.onChange(event.target.value)}><option value="">Select…</option>{enumValues.map(value => <option key={String(value)} value={String(value)}>{String(value)}</option>)}</select></label>;
    if (props.schema.type === 'boolean') return <label className="boolean-input"><input type="checkbox" checked={props.value === true} onChange={event => props.onChange(event.target.checked)} /><span>{label}</span></label>;
    if (props.schema.type === 'number' || props.schema.type === 'integer') return <label><span>{label}{props.required ? ' *' : ''}</span><input type="number" value={typeof props.value === 'number' ? props.value : ''} onChange={event => props.onChange(event.target.value === '' ? undefined : Number(event.target.value))} /></label>;
    if (props.schema.type === 'object' || props.schema.type === 'array') return <CompositeSchemaField label={label} required={props.required} value={props.value ?? (props.schema.type === 'array' ? [] : {})} onChange={props.onChange} />;
    return <label><span>{label}{props.required ? ' *' : ''}</span><input value={typeof props.value === 'string' ? props.value : ''} onChange={event => props.onChange(event.target.value)} /></label>;
}

function CompositeSchemaField(props: { label: string; required: boolean; value: unknown; onChange: (value: unknown) => void }) {
    const [text, setText] = useState(() => JSON.stringify(props.value, null, 2));
    const [invalid, setInvalid] = useState(false);
    useEffect(() => { setText(JSON.stringify(props.value, null, 2)); setInvalid(false); }, [props.value]);
    const commit = () => {
        try { props.onChange(JSON.parse(text)); setInvalid(false); }
        catch { setInvalid(true); }
    };
    return <label><span>{props.label}{props.required ? ' *' : ''}</span><textarea rows={5} value={text} aria-invalid={invalid} onChange={event => { setText(event.target.value); setInvalid(false); }} onBlur={commit} />{invalid && <small className="field-error">Enter valid JSON before queueing.</small>}</label>;
}

function localIssues(input: Record<string, unknown>, properties: Record<string, unknown>, required: Set<string>): string[] {
    const issues: string[] = [];
    for (const name of required) if (input[name] === undefined || input[name] === '') issues.push(`${name} is required.`);
    for (const [name, definition] of Object.entries(properties)) { const schema = record(definition) ? definition : {}; const value = input[name]; if (value === undefined) continue;
        if (schema.type === 'string' && typeof value !== 'string') issues.push(`${name} must be a string.`);
        if ((schema.type === 'number' || schema.type === 'integer') && typeof value !== 'number') issues.push(`${name} must be a number.`);
        if (schema.type === 'integer' && typeof value === 'number' && !Number.isInteger(value)) issues.push(`${name} must be an integer.`);
    }
    return issues;
}
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
