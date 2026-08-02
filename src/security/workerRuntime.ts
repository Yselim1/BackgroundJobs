import { execFile } from 'node:child_process';
import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { AppConfig } from '../config.js';

const execFileAsync = promisify(execFile);
const WINDOWS_ADMINISTRATORS_SID = 'S-1-5-32-544';

export async function prepareWorkerRuntime(config: Pick<AppConfig, 'workerRequireNonAdmin' | 'workerWorkDirectory'>): Promise<void> {
    if (config.workerRequireNonAdmin && await isAdministratorAccount()) {
        throw new Error('The standalone worker must run under a non-administrator operating-system account.');
    }
    if (config.workerWorkDirectory === undefined) return;
    const directory = path.resolve(config.workerWorkDirectory);
    await fs.mkdir(directory, { recursive: true });
    await fs.access(directory, fsConstants.R_OK | fsConstants.W_OK | fsConstants.X_OK);
    process.chdir(directory);
    process.env.WORKER_WORK_DIRECTORY = directory;
    console.log(`Worker working directory: ${directory}`);
}

async function isAdministratorAccount(): Promise<boolean> {
    if (process.platform !== 'win32') return typeof process.getuid === 'function' && process.getuid() === 0;
    try {
        const { stdout } = await execFileAsync('whoami', ['/groups', '/fo', 'csv', '/nh'], {
            windowsHide: true,
            encoding: 'utf8'
        });
        return stdout.toUpperCase().includes(WINDOWS_ADMINISTRATORS_SID);
    } catch (error: unknown) {
        throw new Error(`Unable to verify the Windows worker account: ${error instanceof Error ? error.message : String(error)}`);
    }
}
