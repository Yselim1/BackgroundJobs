import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
    ApiError,
    bulkSetJobStatus,
    createJob,
    getExecutors,
    getManagedSecrets,
    previewSchedule,
    replaceJob,
    validateJob
} from '../api';
import { formatRelativeTime } from '../format';
import { routeSearchParams, setRouteQuery } from '../routes';
import type { Job, JobDefinition, ValidationIssue } from '../types';
import { useModalBehavior } from '../useModalBehavior';
import {
    buildJobDefinition,
    createJobForm,
    createStepForm,
    JobFormError,
    paramsForType,
    stripJobReadOnly,
    type JobForm,
    type StepForm
} from './jobForm';

interface JobsPageProps {
    jobs: Job[];
    loading: boolean;
    runBusy?: string;
    canRun: boolean;
    canWrite: boolean;
    onRun: (jobId: string) => Promise<void>;
    onChanged: () => Promise<void>;
    onError: (message: string | undefined) => void;
}

type StatusFilter = 'all' | 'active' | 'inactive';
type ScheduleFilter = 'all' | 'scheduled' | 'manual';
type JobSort = 'name' | 'status' | 'last_run' | 'next_run' | 'steps';

export function JobsPage(props: JobsPageProps) {
    const initial = useMemo(() => routeSearchParams(), []);
    const [search, setSearch] = useState(initial.get('search') ?? '');
    const [status, setStatus] = useState<StatusFilter>((initial.get('status') as StatusFilter | null) ?? 'all');
    const [schedule, setSchedule] = useState<ScheduleFilter>((initial.get('schedule') as ScheduleFilter | null) ?? 'all');
    const [executor, setExecutor] = useState(initial.get('executor') ?? 'all');
    const [timezone, setTimezone] = useState(initial.get('timezone') ?? 'all');
    const [sort, setSort] = useState<JobSort>((initial.get('sort') as JobSort | null) ?? 'name');
    const [direction, setDirection] = useState<'asc' | 'desc'>((initial.get('direction') as 'desc' | null) ?? 'asc');
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [editorTarget, setEditorTarget] = useState<Job | null>();
    const [duplicating, setDuplicating] = useState(false);
    const [editHandled, setEditHandled] = useState(false);
    const [mutationBusy, setMutationBusy] = useState<string>();
    const [notice, setNotice] = useState<string>();
    const [executors, setExecutors] = useState<string[]>(['SCRIPT', 'RESTAPI', 'COMMAND', 'PYTHON']);
    const [secretNames, setSecretNames] = useState<string[]>([]);

    useEffect(() => {
        setRouteQuery('/jobs', { search, status, schedule, executor, timezone, sort, direction });
    }, [direction, executor, schedule, search, sort, status, timezone]);

    useEffect(() => {
        void getExecutors().then(setExecutors).catch(() => undefined);
        if (props.canWrite) {
            void getManagedSecrets().then(result => setSecretNames(result.items.map(item => item.name))).catch(() => undefined);
        }
    }, [props.canWrite]);

    useEffect(() => {
        const editId = initial.get('edit');
        if (editHandled || editId === null || !props.canWrite || editorTarget !== undefined) return;
        const job = props.jobs.find(item => item.id === editId);
        if (job !== undefined) {
            setEditHandled(true);
            setDuplicating(false);
            setEditorTarget(job);
        }
    }, [editHandled, editorTarget, initial, props.canWrite, props.jobs]);

    const filtered = useMemo(() => {
        const needle = search.trim().toLowerCase();
        const matching = props.jobs.filter(job =>
            (status === 'all' || job.status === status)
            && (schedule === 'all' || (schedule === 'scheduled' ? job.schedule !== undefined : job.schedule === undefined))
            && (executor === 'all' || job.STEPS.some(step => step.TYPE === executor))
            && (timezone === 'all' || job.timezone === timezone)
            && (needle.length === 0 ||
                job.name.toLowerCase().includes(needle) ||
                job.id.toLowerCase().includes(needle))
        );
        return matching.sort((left, right) => {
            const multiplier = direction === 'asc' ? 1 : -1;
            if (sort === 'steps') return (left.STEPS.length - right.STEPS.length) * multiplier;
            const leftValue = sort === 'name' ? left.name : sort === 'status' ? left.status : left[sort] ?? '';
            const rightValue = sort === 'name' ? right.name : sort === 'status' ? right.status : right[sort] ?? '';
            return String(leftValue).localeCompare(String(rightValue)) * multiplier;
        });
    }, [direction, executor, props.jobs, schedule, search, sort, status, timezone]);

    const timezones = useMemo(() => [...new Set(props.jobs.map(job => job.timezone))].sort(), [props.jobs]);
    const selectedJobs = props.jobs.filter(job => selected.has(job.id));

    const toggleStatus = async (job: Job) => {
        const nextStatus = job.status === 'active' ? 'inactive' : 'active';
        setMutationBusy('status:' + job.id);
        setNotice(undefined);
        try {
            if (nextStatus === 'active' && !(await confirmHighFrequency([job]))) return;
            await bulkSetJobStatus([job.id], nextStatus);
            await props.onChanged();
            setNotice(`${job.name} is now ${nextStatus}.`);
            props.onError(undefined);
        } catch (caught) {
            props.onError(errorMessage(caught));
        } finally {
            setMutationBusy(undefined);
        }
    };

    const bulkStatus = async (nextStatus: 'active' | 'inactive') => {
        if (selectedJobs.length === 0) return;
        setMutationBusy('bulk');
        try {
            if (nextStatus === 'active' && !(await confirmHighFrequency(selectedJobs))) return;
            await bulkSetJobStatus(selectedJobs.map(job => job.id), nextStatus);
            await props.onChanged();
            setNotice(`${selectedJobs.length} job${selectedJobs.length === 1 ? '' : 's'} ${nextStatus === 'active' ? 'activated' : 'deactivated'}.`);
            setSelected(new Set());
        } catch (caught) {
            props.onError(errorMessage(caught));
        } finally {
            setMutationBusy(undefined);
        }
    };

    const exportDefinition = (job: Job) => {
        const blob = new Blob([JSON.stringify(stripJobReadOnly(job), null, 2) + '\n'], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = job.id + '.json';
        link.click();
        URL.revokeObjectURL(url);
    };

    return (
        <section className="jobs-page">
            <div className="page-heading">
                <div>
                    <p className="eyebrow">Job management</p>
                    <h1>Jobs</h1>
                    <p>Create workflows, control scheduling, and launch manual executions.</p>
                </div>
                {props.canWrite && (
                    <button className="button button-primary create-job-button" onClick={() => { setDuplicating(false); setEditorTarget(null); }}>
                        New job
                    </button>
                )}
            </div>

            <div className="job-summary" aria-label="Job totals">
                <span><strong>{props.jobs.length}</strong> total</span>
                <span><strong>{props.jobs.filter(job => job.status === 'active').length}</strong> active</span>
                <span><strong>{props.jobs.filter(job => job.schedule === undefined).length}</strong> manual only</span>
            </div>

            {notice !== undefined && (
                <div className="notice-banner" role="status">
                    <span>{notice}</span>
                    <button onClick={() => setNotice(undefined)} aria-label="Dismiss notice">Dismiss</button>
                </div>
            )}

            <div className="jobs-toolbar">
                <label className="search-field">
                    <span>Search jobs</span>
                    <input
                        value={search}
                        onChange={event => setSearch(event.target.value)}
                        placeholder="Name or job ID"
                    />
                </label>
                <label className="select-control">
                    <span>Status</span>
                    <select value={status} onChange={event => setStatus(event.target.value as StatusFilter)}>
                        <option value="all">All jobs</option>
                        <option value="active">Active</option>
                        <option value="inactive">Inactive</option>
                    </select>
                </label>
                <label className="select-control"><span>Schedule</span><select value={schedule} onChange={event => setSchedule(event.target.value as ScheduleFilter)}><option value="all">All</option><option value="scheduled">Scheduled</option><option value="manual">Manual only</option></select></label>
                <label className="select-control"><span>Executor</span><select value={executor} onChange={event => setExecutor(event.target.value)}><option value="all">All</option>{executors.map(value => <option value={value} key={value}>{value}</option>)}</select></label>
                <label className="select-control"><span>Timezone</span><select value={timezone} onChange={event => setTimezone(event.target.value)}><option value="all">All</option>{timezones.map(value => <option value={value} key={value}>{value}</option>)}</select></label>
                <label className="select-control"><span>Sort</span><select value={sort} onChange={event => setSort(event.target.value as JobSort)}><option value="name">Name</option><option value="status">Status</option><option value="last_run">Last run</option><option value="next_run">Next run</option><option value="steps">Steps</option></select></label>
                <button className="button button-quiet sort-direction" onClick={() => setDirection(value => value === 'asc' ? 'desc' : 'asc')} aria-label="Reverse sort direction">{direction === 'asc' ? '↑' : '↓'}</button>
            </div>
            {props.canWrite && selected.size > 0 && (
                <div className="bulk-toolbar">
                    <strong>{selected.size} selected</strong>
                    <button className="button button-quiet" disabled={mutationBusy === 'bulk'} onClick={() => void bulkStatus('active')}>Activate</button>
                    <button className="button button-quiet" disabled={mutationBusy === 'bulk'} onClick={() => void bulkStatus('inactive')}>Deactivate</button>
                    <button className="button button-quiet" onClick={() => setSelected(new Set())}>Clear</button>
                </div>
            )}

            <div className="panel jobs-management-panel">
                <div className="job-management-head" aria-hidden="true">
                    <span />
                    <span>Job</span>
                    <span>Schedule</span>
                    <span>Last / next run</span>
                    <span>Status</span>
                    <span>Actions</span>
                </div>
                <div className="job-management-list">
                    {filtered.map(job => (
                        <article className="job-management-row" key={job.id}>
                            <input
                                type="checkbox"
                                aria-label={'Select ' + job.name}
                                checked={selected.has(job.id)}
                                onChange={event => setSelected(current => {
                                    const next = new Set(current);
                                    if (event.target.checked) next.add(job.id); else next.delete(job.id);
                                    return next;
                                })}
                            />
                            <div className="managed-job-title">
                                <span className="job-state" data-active={job.status === 'active'} aria-hidden="true" />
                                <div>
                                    <strong>{job.name}</strong>
                                    <code>{job.id}</code>
                                    <small>{job.STEPS.length} step{job.STEPS.length === 1 ? '' : 's'}</small>
                                </div>
                            </div>
                            <div className="managed-job-schedule">
                                <strong>{job.schedule ?? 'Manual only'}</strong>
                                <small>{job.timezone}</small>
                            </div>
                            <div className="managed-job-runs">
                                <span>Last {job.last_run === null ? 'never' : formatRelativeTime(job.last_run)}</span>
                                <span>Next {job.next_run === null ? 'not scheduled' : formatRelativeTime(job.next_run)}</span>
                            </div>
                            <div className="managed-job-status">
                                {props.canWrite ? (
                                    <button
                                        className="status-toggle"
                                        data-active={job.status === 'active'}
                                        role="switch"
                                        aria-checked={job.status === 'active'}
                                        onClick={() => void toggleStatus(job)}
                                        disabled={mutationBusy === 'status:' + job.id}
                                        title={job.status === 'active' ? 'Deactivate automatic scheduling' : 'Activate automatic scheduling'}
                                    >
                                        <i aria-hidden="true"><span /></i>
                                        {mutationBusy === 'status:' + job.id ? 'Updating…' : job.status}
                                    </button>
                                ) : (
                                    <span className={'job-status-label ' + job.status}>{job.status}</span>
                                )}
                            </div>
                            <div className="managed-job-actions" aria-label={'Actions for ' + job.name}>
                                {props.canWrite && (
                                    <button className="button button-quiet" onClick={() => { setDuplicating(false); setEditorTarget(job); }}>
                                        Edit
                                    </button>
                                )}
                                <a className="button button-quiet" href={'/jobs/' + encodeURIComponent(job.id)}>View</a>
                                <a className="button button-quiet" href={'/logs?jobId=' + encodeURIComponent(job.id)}>Logs</a>
                                {props.canWrite && <button className="button button-quiet" onClick={() => { setDuplicating(true); setEditorTarget(job); }}>Duplicate</button>}
                                <button className="button button-quiet" onClick={() => exportDefinition(job)}>Export</button>
                                <button
                                    className="button button-run"
                                    onClick={() => void props.onRun(job.id)}
                                    disabled={!props.canRun || props.runBusy === 'run:' + job.id}
                                    title={props.canRun ? 'Queue a manual execution' : 'Operator or admin role required'}
                                >
                                    {props.runBusy === 'run:' + job.id ? 'Queuing…' : 'Run'}
                                </button>
                            </div>
                        </article>
                    ))}
                    {!props.loading && filtered.length === 0 && (
                        <p className="empty">No jobs match this view.</p>
                    )}
                </div>
            </div>

            {editorTarget !== undefined && (
                <JobEditor
                    job={editorTarget ?? undefined}
                    duplicate={duplicating}
                    executors={executors}
                    secretNames={secretNames}
                    onClose={() => setEditorTarget(undefined)}
                    onSaved={async job => {
                        setEditorTarget(undefined);
                        await props.onChanged();
                        setNotice(`${job.name} was ${editorTarget === null || duplicating ? 'created' : 'updated'}.`);
                    }}
                />
            )}
        </section>
    );
}

function JobEditor(props: {
    job?: Job;
    duplicate: boolean;
    executors: string[];
    secretNames: string[];
    onClose: () => void;
    onSaved: (job: Job) => Promise<void>;
}) {
    useModalBehavior(true, props.onClose);
    const editing = props.job !== undefined && !props.duplicate;
    const [form, setForm] = useState<JobForm>(() => {
        const initial = createJobForm(props.job);
        if (!props.duplicate || props.job === undefined) return initial;
        return {
            ...initial,
            id: props.job.id + '-copy',
            name: props.job.name + ' copy',
            status: 'inactive'
        };
    });
    const [issues, setIssues] = useState<ValidationIssue[]>([]);
    const [busy, setBusy] = useState<'validate' | 'save' | 'preview'>();
    const [message, setMessage] = useState<string>();
    const [occurrences, setOccurrences] = useState<string[]>([]);
    const [secretReference, setSecretReference] = useState('');
    const workflow = useMemo(() => workflowPreview(form.steps), [form.steps]);

    const update = <K extends keyof JobForm>(field: K, value: JobForm[K]) => {
        setForm(current => ({ ...current, [field]: value }));
        setIssues([]);
        setMessage(undefined);
    };
    const updateStep = (key: string, updateValue: Partial<StepForm>) => {
        setForm(current => ({
            ...current,
            steps: current.steps.map(step => step.key === key ? { ...step, ...updateValue } : step)
        }));
        setIssues([]);
        setMessage(undefined);
    };
    const moveStep = (index: number, direction: -1 | 1) => {
        setForm(current => {
            const target = index + direction;
            if (target < 0 || target >= current.steps.length) return current;
            const steps = [...current.steps];
            [steps[index], steps[target]] = [steps[target]!, steps[index]!];
            return { ...current, steps };
        });
    };

    const checkDefinition = async (): Promise<JobDefinition | undefined> => {
        try {
            const definition = buildJobDefinition(form);
            const validation = await validateJob(definition);
            if (!validation.valid) {
                setIssues(validation.errors);
                setMessage(undefined);
                return undefined;
            }
            setIssues([]);
            return validation.job;
        } catch (caught) {
            if (caught instanceof JobFormError) {
                setIssues([{ path: caught.field, code: 'FORM_VALUE_INVALID', message: caught.message }]);
            } else if (caught instanceof ApiError && Array.isArray(caught.details)) {
                setIssues(caught.details as ValidationIssue[]);
            } else {
                setIssues([{ path: '$', code: 'EDITOR_ERROR', message: errorMessage(caught) }]);
            }
            setMessage(undefined);
            return undefined;
        }
    };

    const handleValidate = async () => {
        setBusy('validate');
        const definition = await checkDefinition();
        if (definition !== undefined) setMessage('Definition is valid and ready to save.');
        setBusy(undefined);
    };

    const handlePreview = async () => {
        setBusy('preview');
        try {
            const result = await previewSchedule(form.schedule, form.timezone, 5);
            setOccurrences(result.occurrences);
            setIssues([]);
        } catch (caught) {
            setIssues([{ path: 'schedule', code: 'SCHEDULE_PREVIEW_FAILED', message: errorMessage(caught) }]);
            setOccurrences([]);
        } finally {
            setBusy(undefined);
        }
    };

    const submit = async (event: FormEvent) => {
        event.preventDefault();
        setBusy('save');
        try {
            const definition = await checkDefinition();
            if (definition === undefined) return;
            if (
                definition.status === 'active'
                && (!editing || props.job?.status !== 'active')
                && !(await confirmDefinitionFrequency(definition))
            ) return;
            const saved = editing
                ? await replaceJob(props.job!.id, definition)
                : await createJob(definition);
            await props.onSaved(saved);
        } catch (caught) {
            if (caught instanceof ApiError && Array.isArray(caught.details)) {
                setIssues(caught.details as ValidationIssue[]);
            } else {
                setIssues([{ path: '$', code: 'SAVE_FAILED', message: errorMessage(caught) }]);
            }
        } finally {
            setBusy(undefined);
        }
    };

    return (
        <>
            <button className="drawer-backdrop visible" onClick={props.onClose} aria-label="Close job editor" />
            <aside className="job-editor" role="dialog" aria-modal="true" aria-labelledby="job-editor-title">
                <form onSubmit={event => void submit(event)}>
                    <header className="job-editor-head">
                        <div>
                            <p className="eyebrow">{editing ? 'Edit definition' : 'New definition'}</p>
                            <h2 id="job-editor-title">{editing ? props.job!.name : 'Create a job'}</h2>
                        </div>
                        <button className="close" type="button" onClick={props.onClose} aria-label="Close">×</button>
                    </header>

                    {issues.length > 0 && (
                        <div className="validation-summary" role="alert">
                            <strong>Fix {issues.length} issue{issues.length === 1 ? '' : 's'} before saving</strong>
                            <ul>
                                {issues.map((issue, index) => (
                                    <li key={issue.path + issue.code + index}>
                                        <code>{issue.path}</code> {issue.message}
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}
                    {message !== undefined && <div className="editor-valid" role="status">{message}</div>}

                    <section className="editor-section">
                        <div className="editor-section-title">
                            <span>01</span>
                            <div><h3>Identity & scheduling</h3><p>Define how the job is identified and when it runs.</p></div>
                        </div>
                        <div className="editor-grid">
                            <Field label="Job ID" className="wide">
                                <input
                                    value={form.id}
                                    onChange={event => update('id', event.target.value)}
                                    disabled={editing}
                                    placeholder="daily-report"
                                    required
                                />
                            </Field>
                            <Field label="Name" className="wide">
                                <input value={form.name} onChange={event => update('name', event.target.value)} required />
                            </Field>
                            <Field label="Description" className="full">
                                <textarea
                                    value={form.description}
                                    onChange={event => update('description', event.target.value)}
                                    rows={2}
                                    placeholder="What this workflow does"
                                />
                            </Field>
                            <Field label="Initial status">
                                <select value={form.status} onChange={event => update('status', event.target.value as JobForm['status'])}>
                                    <option value="inactive">Inactive</option>
                                    <option value="active">Active</option>
                                </select>
                            </Field>
                            <Field label="Timezone">
                                <input value={form.timezone} onChange={event => update('timezone', event.target.value)} required />
                            </Field>
                            <Field label="Schedule" hint="Six fields, beginning with seconds" className="wide">
                                <input
                                    value={form.schedule}
                                    onChange={event => update('schedule', event.target.value)}
                                    placeholder="0 0 8 * * *"
                                />
                            </Field>
                            <div className="schedule-preview-control wide">
                                <button className="button button-quiet" type="button" disabled={busy !== undefined || form.schedule.trim().length === 0} onClick={() => void handlePreview()}>
                                    {busy === 'preview' ? 'Calculating…' : 'Preview next 5 runs'}
                                </button>
                                {occurrences.length > 0 && <ol>{occurrences.map(value => <li key={value}>{new Date(value).toLocaleString()} <small>{form.timezone}</small></li>)}</ol>}
                            </div>
                            <Field label="Job timeout (ms)">
                                <input type="number" min="1" value={form.timeoutMs} onChange={event => update('timeoutMs', event.target.value)} />
                            </Field>
                            <Field label="Step concurrency">
                                <input type="number" min="1" value={form.maxConcurrency} onChange={event => update('maxConcurrency', event.target.value)} />
                            </Field>
                            <Field label="Failure policy">
                                <select
                                    value={form.failurePolicy}
                                    onChange={event => update('failurePolicy', event.target.value as JobForm['failurePolicy'])}
                                >
                                    <option value="fail_fast">Fail fast</option>
                                    <option value="continue_independent">Continue independent</option>
                                </select>
                            </Field>
                        </div>
                    </section>

                    <section className="editor-section">
                        <div className="editor-section-title">
                            <span>02</span>
                            <div><h3>Default retry policy</h3><p>Leave attempts and delay empty to use one attempt.</p></div>
                        </div>
                        <div className="editor-grid three">
                            <Field label="Maximum attempts">
                                <input type="number" min="1" value={form.retryMaxAttempts} onChange={event => update('retryMaxAttempts', event.target.value)} />
                            </Field>
                            <Field label="Delay (ms)">
                                <input type="number" min="0" value={form.retryDelayMs} onChange={event => update('retryDelayMs', event.target.value)} />
                            </Field>
                            <Field label="Backoff">
                                <select value={form.retryBackoff} onChange={event => update('retryBackoff', event.target.value as JobForm['retryBackoff'])}>
                                    <option value="fixed">Fixed</option>
                                    <option value="exponential">Exponential</option>
                                </select>
                            </Field>
                        </div>
                    </section>

                    <section className="editor-section">
                        <div className="editor-section-title step-section-heading">
                            <span>03</span>
                            <div><h3>Workflow steps</h3><p>Steps execute in order unless dependencies allow parallel work.</p></div>
                            <button
                                className="button button-quiet"
                                type="button"
                                onClick={() => update('steps', [...form.steps, createStepForm()])}
                            >
                                Add step
                            </button>
                        </div>
                        {props.secretNames.length > 0 && (
                            <div className="secret-reference-helper">
                                <div>
                                    <strong>Managed secret reference</strong>
                                    <small>Choose a secret name to copy its template. Secret values are never loaded into this editor.</small>
                                </div>
                                <input
                                    list="managed-secret-names"
                                    value={secretReference}
                                    onChange={event => setSecretReference(event.target.value)}
                                    placeholder="SECRET_NAME"
                                />
                                <datalist id="managed-secret-names">{props.secretNames.map(name => <option value={name} key={name} />)}</datalist>
                                <button className="button button-quiet" type="button" disabled={!props.secretNames.includes(secretReference)} onClick={() => void navigator.clipboard.writeText('{{secrets.' + secretReference + '}}')}>Copy reference</button>
                            </div>
                        )}
                        <div className="step-editor-list">
                            {form.steps.map((step, index) => (
                                <article className="step-editor" key={step.key}>
                                    <header>
                                        <span>{String(index + 1).padStart(2, '0')}</span>
                                        <strong>{step.name.trim() || 'Untitled step'}</strong>
                                        <div>
                                            <button type="button" onClick={() => moveStep(index, -1)} disabled={index === 0} aria-label="Move step up">↑</button>
                                            <button type="button" onClick={() => moveStep(index, 1)} disabled={index === form.steps.length - 1} aria-label="Move step down">↓</button>
                                            <button
                                                type="button"
                                                onClick={() => update('steps', form.steps.filter(item => item.key !== step.key))}
                                                disabled={form.steps.length === 1}
                                                aria-label="Remove step"
                                            >×</button>
                                        </div>
                                    </header>
                                    <div className="editor-grid">
                                        <Field label="Step ID">
                                            <input value={step.id} onChange={event => updateStep(step.key, { id: event.target.value })} required />
                                        </Field>
                                        <Field label="Name">
                                            <input value={step.name} onChange={event => updateStep(step.key, { name: event.target.value })} required />
                                        </Field>
                                        <Field label="Executor">
                                            <select
                                                value={step.type}
                                                onChange={event => {
                                                    const type = event.target.value;
                                                    updateStep(step.key, { type, params: paramsForType(type) });
                                                }}
                                            >
                                                {props.executors.map(type => <option value={type} key={type}>{type}</option>)}
                                            </select>
                                        </Field>
                                        <Field label="Dependencies" hint="Comma-separated step IDs">
                                            <input value={step.dependencies} onChange={event => updateStep(step.key, { dependencies: event.target.value })} />
                                        </Field>
                                        <Field label="Executor parameters" hint="JSON object" className="full">
                                            <textarea
                                                className="code-input"
                                                value={step.params}
                                                onChange={event => updateStep(step.key, { params: event.target.value })}
                                                rows={7}
                                                spellCheck={false}
                                            />
                                        </Field>
                                        <details className="advanced-fields full">
                                            <summary>Advanced step options</summary>
                                            <p>Conditions, fan-out, per-step retry, and failure behavior as JSON.</p>
                                            <textarea
                                                className="code-input"
                                                value={step.advanced}
                                                onChange={event => updateStep(step.key, { advanced: event.target.value })}
                                                rows={5}
                                                spellCheck={false}
                                            />
                                        </details>
                                    </div>
                                </article>
                            ))}
                        </div>
                        <div className="workflow-preview">
                            <div><strong>Dependency preview</strong><small>Columns run sequentially; cards in the same column can run in parallel.</small></div>
                            <div className="workflow-preview-levels">
                                {workflow.map((level, index) => (
                                    <div key={index}><span>Level {index + 1}</span>{level.map(step => <article key={step.key}><strong>{step.name || step.id || 'Untitled step'}</strong><code>{step.id || 'missing-id'}</code></article>)}</div>
                                ))}
                            </div>
                        </div>
                    </section>

                    <section className="editor-section">
                        <details className="advanced-fields">
                            <summary>Advanced job options</summary>
                            <p>Webhook definitions and plugin-specific top-level fields as JSON.</p>
                            <textarea
                                className="code-input"
                                value={form.advanced}
                                onChange={event => update('advanced', event.target.value)}
                                rows={6}
                                spellCheck={false}
                            />
                        </details>
                    </section>

                    <footer className="job-editor-actions">
                        <button className="button button-quiet" type="button" onClick={props.onClose}>Cancel</button>
                        <button className="button button-quiet" type="button" onClick={() => void handleValidate()} disabled={busy !== undefined}>
                            {busy === 'validate' ? 'Validating…' : 'Validate'}
                        </button>
                        <button className="button button-primary" disabled={busy !== undefined}>
                            {busy === 'save' ? 'Saving…' : editing ? 'Save changes' : 'Create job'}
                        </button>
                    </footer>
                </form>
            </aside>
        </>
    );
}

function Field(props: {
    label: string;
    hint?: string;
    className?: string;
    children: React.ReactNode;
}) {
    return (
        <label className={'editor-field ' + (props.className ?? '')}>
            <span>{props.label}</span>
            {props.children}
            {props.hint !== undefined && <small>{props.hint}</small>}
        </label>
    );
}

function errorMessage(caught: unknown): string {
    return caught instanceof Error ? caught.message : String(caught);
}

async function confirmHighFrequency(jobs: Job[]): Promise<boolean> {
    for (const job of jobs) {
        if (job.schedule === undefined) continue;
        const result = await previewSchedule(job.schedule, job.timezone, 3);
        if (isHighFrequency(result.occurrences)) {
            return window.confirm(
                job.name + ' runs more frequently than once per minute. Activating it can create substantial execution volume. Continue?'
            );
        }
    }
    return true;
}

async function confirmDefinitionFrequency(definition: JobDefinition): Promise<boolean> {
    if (definition.schedule === undefined) return true;
    const result = await previewSchedule(definition.schedule, definition.timezone, 3);
    if (!isHighFrequency(result.occurrences)) return true;
    return window.confirm(
        'This schedule runs more frequently than once per minute. Activating it can create substantial execution volume. Continue?'
    );
}

function isHighFrequency(occurrences: string[]): boolean {
    return occurrences.some((value, index) =>
        index > 0 && Date.parse(value) - Date.parse(occurrences[index - 1]!) < 60_000
    );
}

function workflowPreview(steps: StepForm[]): StepForm[][] {
    const byId = new Map(steps.filter(step => step.id.length > 0).map(step => [step.id, step]));
    const depth = new Map<string, number>();
    const visit = (step: StepForm, visiting = new Set<string>()): number => {
        if (depth.has(step.key)) return depth.get(step.key)!;
        if (visiting.has(step.key)) return 0;
        visiting.add(step.key);
        const dependencies = step.dependencies.split(',').map(value => value.trim()).filter(Boolean);
        const level = dependencies.length === 0
            ? 0
            : 1 + Math.max(0, ...dependencies.map(id => {
                const dependency = byId.get(id);
                return dependency === undefined ? -1 : visit(dependency, new Set(visiting));
            }));
        depth.set(step.key, level);
        return level;
    };
    const levels: StepForm[][] = [];
    for (const step of steps) {
        const level = visit(step);
        (levels[level] ??= []).push(step);
    }
    return levels;
}
