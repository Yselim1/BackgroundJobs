import { useCallback, useEffect, useState } from 'react';
import { getSystemStatus } from '../api';
import { formatDuration, formatRelativeTime, titleCase } from '../format';
import type { SystemStatus } from '../types';

export function SystemAdmin(props: { onError: (error?: string) => void }) {
    const [status, setStatus] = useState<SystemStatus>();
    const [loading, setLoading] = useState(true);

    const load = useCallback(async (quiet = false) => {
        if (!quiet) setLoading(true);
        try {
            setStatus(await getSystemStatus());
            props.onError(undefined);
        } catch (caught) {
            props.onError(caught instanceof Error ? caught.message : String(caught));
        } finally {
            setLoading(false);
        }
    }, [props.onError]);

    useEffect(() => {
        void load();
        const timer = window.setInterval(() => void load(true), 15_000);
        return () => window.clearInterval(timer);
    }, [load]);

    return (
        <section className='system-admin'>
            <div className='panel admin-panel'>
                <div className='panel-heading'>
                    <div><p className='eyebrow'>Read-only health</p><h2>System</h2></div>
                    <button className='button button-quiet' disabled={loading} onClick={() => void load()}>{loading ? 'Refreshing…' : 'Refresh status'}</button>
                </div>
                <div className='system-status-grid'>
                    <StatusCard title='Execution manager' value={status?.services.executionManager ?? 'loading'} />
                    <StatusCard title='Webhook dispatcher' value={status?.services.webhookDispatcher ?? 'loading'} />
                    <StatusCard title='Database' value={status?.database.status ?? 'loading'} note={status === undefined ? undefined : `${status.database.latencyMs} ms · schema ${status.database.schemaVersion}/${status.database.expectedSchemaVersion}`} />
                    <StatusCard title='Secret encryption' value={status?.secrets.configured === true ? 'configured' : status === undefined ? 'loading' : 'unconfigured'} />
                </div>
                {status !== undefined && <small className='system-generated'>Updated {formatRelativeTime(status.generatedAt)}</small>}
            </div>
            {status !== undefined && (
                <div className='system-config-grid'>
                    <ConfigPanel title='Workers' items={[
                        ['Concurrency', String(status.workers.concurrency)],
                        ['Scheduler poll', formatDuration(status.workers.schedulerPollMs)],
                        ['Shutdown grace', formatDuration(status.workers.shutdownGraceMs)],
                        ['Database pool max', String(status.workers.databasePoolMax)]
                    ]} />
                    <ConfigPanel title='Webhooks' items={[
                        ['Concurrency', String(status.webhooks.concurrency)],
                        ['Poll interval', formatDuration(status.webhooks.pollMs)],
                        ['Maximum attempts', String(status.webhooks.maxAttempts)],
                        ['Request timeout', formatDuration(status.webhooks.requestTimeoutMs)],
                        ['Legacy signing key', status.webhooks.legacySigningKeyConfigured ? 'Configured' : 'Not configured']
                    ]} />
                    <ConfigPanel title='Authentication' items={[
                        ['Session lifetime', formatDuration(status.authentication.sessionTtlMs)],
                        ['Idle timeout', formatDuration(status.authentication.sessionIdleMs)],
                        ['Secure cookies', status.authentication.secureCookies ? 'Enabled' : 'Disabled'],
                        ['Trusted proxy', status.authentication.trustProxy ? 'Enabled' : 'Disabled']
                    ]} />
                    <section className='panel config-panel'>
                        <p className='eyebrow'>Operator-run</p><h3>Execution retention</h3>
                        <p>Retention remains an explicit dry-run-first maintenance action.</p>
                        <code>{status.retention.dryRunCommand}</code>
                        <code>{status.retention.confirmCommand}</code>
                    </section>
                </div>
            )}
        </section>
    );
}

function StatusCard(props: { title: string; value: string; note?: string }) {
    return <article><span>{props.title}</span><strong>{titleCase(props.value)}</strong>{props.note !== undefined && <small>{props.note}</small>}</article>;
}

function ConfigPanel(props: { title: string; items: Array<[string, string]> }) {
    return (
        <section className='panel config-panel'>
            <p className='eyebrow'>Runtime configuration</p><h3>{props.title}</h3>
            <dl>{props.items.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
        </section>
    );
}
