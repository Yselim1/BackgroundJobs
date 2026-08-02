import { useEffect, useRef, useState } from 'react';
import { getCommandSearch } from './api';
import { navigate } from './routes';

type Results = Awaited<ReturnType<typeof getCommandSearch>>;
export function CommandPalette() {
    const [open, setOpen] = useState(false); const [query, setQuery] = useState(''); const [results, setResults] = useState<Results>(); const input = useRef<HTMLInputElement>(null);
    useEffect(() => { const keyboard = (event: KeyboardEvent) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setOpen(value => !value); } if (event.key === 'Escape') setOpen(false); }; const openRequested = () => setOpen(true); window.addEventListener('keydown', keyboard); window.addEventListener('workline:open-command', openRequested); return () => { window.removeEventListener('keydown', keyboard); window.removeEventListener('workline:open-command', openRequested); }; }, []);
    useEffect(() => { if (open) window.setTimeout(() => input.current?.focus(), 0); }, [open]);
    useEffect(() => { if (query.trim().length < 2) { setResults(undefined); return; } const timer = window.setTimeout(() => void getCommandSearch(query.trim()).then(setResults).catch(() => setResults(undefined)), 180); return () => window.clearTimeout(timer); }, [query]);
    const go = (path: string) => { setOpen(false); setQuery(''); navigate(path); };
    return <>{open && <><button className="command-backdrop" onClick={() => setOpen(false)} aria-label="Close command search" /><section className="command-palette" role="dialog" aria-modal="true" aria-label="Command search"><label><span>Command search</span><input ref={input} value={query} onChange={event => setQuery(event.target.value)} placeholder="Jobs, executions, incidents, or actions" /></label><div className="command-results">
        {results?.jobs.map(job => <button key={'j' + job.id} onClick={() => go('/jobs/' + encodeURIComponent(job.id))}><span>Job</span><strong>{job.name}</strong><code>{job.id}</code></button>)}
        {results?.executions.map(execution => <button key={'e' + execution.id} onClick={() => go('/logs/' + execution.id)}><span>Execution</span><strong>{execution.job_id}</strong><code>{execution.id}</code></button>)}
        {results?.incidents.map(incident => <button key={'i' + incident.id} onClick={() => go('/attention?state=open&incident=' + incident.id)}><span>{incident.severity} incident</span><strong>{incident.job_id}</strong><small>{incident.reason}</small></button>)}
        {results?.actions.map(action => <button key={action.id} onClick={() => go(action.id === 'open-attention' ? '/attention' : '/jobs')}><span>Action</span><strong>{action.label}</strong></button>)}
        {query.length >= 2 && results !== undefined && [...results.jobs, ...results.executions, ...results.incidents, ...results.actions].length === 0 && <p>No permitted results.</p>}
    </div><footer><kbd>Esc</kbd> close <span><kbd>Ctrl</kbd>/<kbd>⌘</kbd> + <kbd>K</kbd></span></footer></section></>}</>;
}
