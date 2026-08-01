import { useEffect, useState } from 'react';
import { getExecutions, getJobPlan } from '../api';
import { formatDuration, formatRelativeTime, titleCase } from '../format';
import type { ExecutionSummary, Job, JobPlan } from '../types';

interface JobDetailPageProps {
    job?: Job;
    canRun: boolean;
    canWrite: boolean;
    liveVersion: number;
    runBusy?: string;
    onRun: (jobId: string) => Promise<void>;
    onOpenExecution: (executionId: string) => Promise<void>;
    onError: (message: string | undefined) => void;
}

export function JobDetailPage(props: JobDetailPageProps) {
    const [plan, setPlan] = useState<JobPlan>();
    const [executions, setExecutions] = useState<ExecutionSummary[]>([]);

    useEffect(() => {
        if (props.job === undefined) return;
        void Promise.all([getJobPlan(props.job.id), getExecutions({ jobId: props.job.id, limit: 10 })])
            .then(([nextPlan, page]) => { setPlan(nextPlan); setExecutions(page.items); props.onError(undefined); })
            .catch(caught => props.onError(caught instanceof Error ? caught.message : String(caught)));
    }, [props.job?.id, props.liveVersion]);

    if (props.job === undefined) return <p className="empty">Job not found.</p>;
    const job = props.job;
    return (
        <section className="job-detail-page">
            <div className="page-heading job-detail-heading">
                <div>
                    <p className="eyebrow">Job definition</p>
                    <h1>{job.name}</h1>
                    <p><code>{job.id}</code>{job.description === undefined ? '' : ' · ' + job.description}</p>
                </div>
                <div className="page-actions">
                    <a className="button button-quiet" href="/jobs">Back to jobs</a>
                    <a className="button button-quiet" href={'/logs?jobId=' + encodeURIComponent(job.id)}>View logs</a>
                    {props.canWrite && <a className="button button-quiet" href={'/jobs?edit=' + encodeURIComponent(job.id)}>Edit job</a>}
                    <button className="button button-run" disabled={!props.canRun || props.runBusy === 'run:' + job.id} onClick={() => void props.onRun(job.id)}>Run now</button>
                </div>
            </div>
            <div className="job-detail-stats">
                <Detail label="Status" value={titleCase(job.status)} />
                <Detail label="Schedule" value={job.schedule ?? 'Manual only'} note={job.timezone} />
                <Detail label="Timeout" value={job.TIMEOUT_MS === undefined ? 'No job limit' : formatDuration(job.TIMEOUT_MS)} />
                <Detail label="Step concurrency" value={String(plan?.maxConcurrency ?? job.MAX_CONCURRENCY ?? 10)} />
                <Detail label="Last run" value={job.last_run === null ? 'Never' : formatRelativeTime(job.last_run)} />
                <Detail label="Next run" value={job.next_run === null ? 'Not scheduled' : formatRelativeTime(job.next_run)} />
            </div>
            <section className="panel workflow-panel">
                <div className="panel-heading"><div><p className="eyebrow">Dependency graph</p><h2>Workflow plan</h2></div><span>{job.STEPS.length} steps</span></div>
                <WorkflowPlan plan={plan} />
            </section>
            <section className="panel runs-panel job-recent-runs">
                <div className="panel-heading"><div><p className="eyebrow">History</p><h2>Recent executions</h2></div><a href={'/logs?jobId=' + encodeURIComponent(job.id)}>All logs →</a></div>
                <div className="table-wrap"><table><thead><tr><th>Status</th><th>Trigger</th><th>Requested by</th><th>Requested</th><th>Duration</th></tr></thead><tbody>
                    {executions.map(execution => <tr key={execution.executionId} onClick={() => void props.onOpenExecution(execution.executionId)} className="clickable-row"><td><Status status={execution.status} /></td><td>{titleCase(execution.trigger)}</td><td>{execution.requestedBy.label}</td><td>{formatRelativeTime(execution.requestedAt)}</td><td>{formatDuration(execution.durationMs)}</td></tr>)}
                    {executions.length === 0 && <tr><td className="empty" colSpan={5}>This job has not run yet.</td></tr>}
                </tbody></table></div>
            </section>
        </section>
    );
}

function WorkflowPlan({ plan }: { plan?: JobPlan }) {
    if (plan === undefined) return <p className="empty">Loading workflow plan…</p>;
    return <div className="workflow-levels">{plan.levels.map(level => <div className="workflow-level" key={level.level}><span>Level {level.level}</span><div>{level.steps.map(step => <article key={step.id}><strong>{step.name}</strong><code>{step.id}</code><small>{step.type}{step.dependsOn.length === 0 ? ' · entry step' : ' · after ' + step.dependsOn.join(', ')}</small></article>)}</div></div>)}</div>;
}

function Detail(props: { label: string; value: string; note?: string }) { return <article><span>{props.label}</span><strong>{props.value}</strong>{props.note !== undefined && <small>{props.note}</small>}</article>; }
function Status(props: { status: string }) { return <span className={'status status-' + props.status}><i aria-hidden="true" />{titleCase(props.status)}</span>; }
