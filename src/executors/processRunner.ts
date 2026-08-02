import { spawn, type ChildProcess } from 'node:child_process';
import { abortError, throwIfAborted } from '../errors.js';

const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const FORCE_KILL_GRACE_MS = 500;
const WINDOWS_ENVIRONMENT_KEYS = ['PATH', 'SystemRoot', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP'] as const;
const POSIX_ENVIRONMENT_KEYS = ['PATH', 'LANG', 'LC_ALL', 'TMPDIR'] as const;

export interface ProcessOptions {
    command: string;
    args?: string[];
    shell?: boolean;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs: number;
    signal: AbortSignal;
}

export interface ProcessResult { stdout: string; stderr: string; exitCode: number; }

export function buildChildEnvironment(explicit: Record<string, string> = {}): NodeJS.ProcessEnv {
    const result: NodeJS.ProcessEnv = {};
    const keys = process.platform === 'win32' ? WINDOWS_ENVIRONMENT_KEYS : POSIX_ENVIRONMENT_KEYS;
    const sourceKeys = Object.keys(process.env);
    for (const expected of keys) {
        const actual = process.platform === 'win32'
            ? sourceKeys.find(key => key.toLowerCase() === expected.toLowerCase())
            : expected;
        if (actual !== undefined && process.env[actual] !== undefined) result[actual] = process.env[actual];
    }
    return { ...result, ...explicit };
}

export async function runProcess(options: ProcessOptions): Promise<ProcessResult> {
    throwIfAborted(options.signal);
    const timeoutController = new AbortController();
    const timeout = setTimeout(
        () => timeoutController.abort(new Error(`Process timed out after ${options.timeoutMs}ms.`)),
        options.timeoutMs
    );
    const signal = AbortSignal.any([options.signal, timeoutController.signal]);

    try {
        return await new Promise<ProcessResult>((resolve, reject) => {
            const child = spawn(options.command, options.args ?? [], {
                shell: options.shell ?? false,
                cwd: options.cwd,
                env: options.env,
                windowsHide: true,
                detached: process.platform !== 'win32'
            });
            let stdout = '';
            let stderr = '';
            let outputBytes = 0;
            let settled = false;

            const finish = (work: () => void): void => {
                if (settled) return;
                settled = true;
                signal.removeEventListener('abort', onAbort);
                work();
            };
            const append = (target: 'stdout' | 'stderr', chunk: Buffer): void => {
                outputBytes += chunk.byteLength;
                if (outputBytes > MAX_OUTPUT_BYTES) {
                    void terminateProcessTree(child);
                    finish(() => reject(new Error('Process output exceeded the 10 MiB limit.')));
                    return;
                }
                if (target === 'stdout') stdout += chunk.toString();
                else stderr += chunk.toString();
            };
            const onAbort = (): void => {
                void terminateProcessTree(child);
                const reason = options.signal.aborted
                    ? abortError(options.signal)
                    : timeoutController.signal.reason;
                finish(() => reject(reason instanceof Error ? reason : new Error(String(reason))));
            };

            child.stdout?.on('data', (chunk: Buffer) => append('stdout', chunk));
            child.stderr?.on('data', (chunk: Buffer) => append('stderr', chunk));
            child.once('error', error => finish(() => reject(
                signal.aborted ? (options.signal.aborted ? abortError(options.signal) : timeoutController.signal.reason) : error
            )));
            child.once('close', (code, closeSignal) => finish(() => {
                if (signal.aborted) reject(options.signal.aborted ? abortError(options.signal) : timeoutController.signal.reason);
                else if (code === 0) resolve({ stdout: stdout.trim(), stderr: stderr.trim(), exitCode: 0 });
                else reject(new Error(`Process exited with code ${code ?? 'unknown'}${closeSignal ? ` and signal ${closeSignal}` : ''}. stderr: ${stderr.trim() || '<empty>'}`));
            }));
            signal.addEventListener('abort', onAbort, { once: true });
            if (signal.aborted) onAbort();
        });
    } finally {
        clearTimeout(timeout);
    }
}

async function terminateProcessTree(child: ChildProcess): Promise<void> {
    const pid = child.pid;
    if (pid === undefined || child.exitCode !== null) return;
    if (process.platform === 'win32') {
        // Windows does not expose POSIX process-group signals. taskkill /T /F
        // is the reliable way to prevent a descendant from surviving its parent.
        await runTaskkill(pid, true);
        return;
    }
    try { process.kill(-pid, 'SIGTERM'); } catch { return; }
    const forceTimer = setTimeout(() => {
        try { process.kill(-pid, 'SIGKILL'); } catch { /* already stopped */ }
    }, FORCE_KILL_GRACE_MS);
    child.once('close', () => clearTimeout(forceTimer));
}

function runTaskkill(pid: number, force: boolean): Promise<void> {
    return new Promise(resolve => {
        const args = ['/PID', String(pid), '/T'];
        if (force) args.push('/F');
        const killer = spawn('taskkill', args, { windowsHide: true, stdio: 'ignore' });
        killer.once('close', () => resolve());
        killer.once('error', () => resolve());
    });
}
