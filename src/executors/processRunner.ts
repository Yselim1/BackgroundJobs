import { spawn, type ChildProcess } from 'node:child_process';
import { abortError, throwIfAborted } from '../errors.js';

const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const FORCE_KILL_GRACE_MS = 500;

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
        await runTaskkill(pid, false);
        const forceTimer = setTimeout(() => void runTaskkill(pid, true), FORCE_KILL_GRACE_MS);
        child.once('close', () => clearTimeout(forceTimer));
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
