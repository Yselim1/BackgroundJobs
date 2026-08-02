import { useEffect, useMemo, useState } from 'react';
import { routeSearchParams, setRouteQuery } from '../routes';
import type { Job } from '../types';
import { JobAutomationsPanel } from './JobAutomationsPanel';

interface AutomationsPageProps {
    jobs: Job[];
    canWrite: boolean;
    refreshVersion: number;
    onOpenExecution: (executionId: string) => Promise<void>;
    onError: (message: string | undefined) => void;
}

export function AutomationsPage(props: AutomationsPageProps) {
    const initialJobId = useMemo(() => routeSearchParams().get('jobId') ?? '', []);
    const [jobId, setJobId] = useState(initialJobId);
    const selectedJob = props.jobs.find(job => job.id === jobId);

    useEffect(() => {
        if (selectedJob === undefined && props.jobs.length > 0) setJobId(props.jobs[0].id);
    }, [props.jobs, selectedJob]);

    useEffect(() => {
        setRouteQuery('/jobs', { view: 'automations', jobId });
    }, [jobId]);

    return (
        <section className="automations-page">
            <div className="page-heading automations-heading">
                <div>
                    <p className="eyebrow">Event-driven operations</p>
                    <h1>Automations</h1>
                    <p>Manage inbound webhooks and job-completion chains for a target job.</p>
                </div>
                <label className="automation-job-picker">
                    <span>Target job</span>
                    <select value={selectedJob?.id ?? ''} onChange={event => setJobId(event.target.value)} disabled={props.jobs.length === 0}>
                        {props.jobs.length === 0 && <option value="">No jobs available</option>}
                        {props.jobs.map(job => <option key={job.id} value={job.id}>{job.name}</option>)}
                    </select>
                </label>
            </div>
            {selectedJob === undefined
                ? <div className="panel empty-copy">Create a job before configuring automations.</div>
                : <JobAutomationsPanel
                    job={selectedJob}
                    jobs={props.jobs}
                    canWrite={props.canWrite}
                    refreshVersion={props.refreshVersion}
                    onOpenExecution={props.onOpenExecution}
                    onError={props.onError}
                />}
        </section>
    );
}
