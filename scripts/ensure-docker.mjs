import { spawn, execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const dockerCommand = process.platform === 'win32' ? 'docker.exe' : 'docker';
const startTimeoutMs = 120_000;
const pollIntervalMs = 2_000;

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function isDockerReady() {
  try {
    await execFileAsync(dockerCommand, ['info', '--format', '{{.ServerVersion}}'], {
      timeout: 5_000,
      windowsHide: true,
    });
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error('Docker CLI was not found. Install Docker Desktop and make sure docker is on PATH.');
    }

    return false;
  }
}

async function launchDetached(command, args = []) {
  const child = spawn(command, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });

  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  child.unref();
}

async function firstExistingPath(candidates) {
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next standard installation location.
    }
  }

  return undefined;
}

async function launchDockerDesktopFallback() {
  if (process.platform === 'win32') {
    const executable = await firstExistingPath([
      path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Docker', 'Docker', 'Docker Desktop.exe'),
      ...(process.env.LOCALAPPDATA
        ? [path.join(process.env.LOCALAPPDATA, 'Docker', 'Docker Desktop.exe')]
        : []),
    ]);

    if (!executable) {
      return false;
    }

    await launchDetached(executable);
    return true;
  }

  if (process.platform === 'darwin') {
    await launchDetached('open', ['-a', 'Docker']);
    return true;
  }

  return false;
}

async function startDockerDesktop() {
  console.log('[docker] Docker is not running; starting Docker Desktop...');

  try {
    await execFileAsync(dockerCommand, ['desktop', 'start'], {
      timeout: startTimeoutMs,
      windowsHide: true,
    });
    return;
  } catch {
    // Older Docker Desktop releases do not include `docker desktop start`.
  }

  if (await isDockerReady()) {
    return;
  }

  if (!(await launchDockerDesktopFallback())) {
    throw new Error(
      'Docker could not be started automatically. Start Docker Desktop (or the Docker daemon) and try again.',
    );
  }
}

async function waitForDocker() {
  const deadline = Date.now() + startTimeoutMs;
  let nextProgressMessage = Date.now() + 10_000;

  while (Date.now() < deadline) {
    if (await isDockerReady()) {
      console.log('[docker] Docker is ready.');
      return;
    }

    if (Date.now() >= nextProgressMessage) {
      console.log('[docker] Still waiting for Docker Desktop...');
      nextProgressMessage += 10_000;
    }

    await sleep(pollIntervalMs);
  }

  throw new Error(
    `Docker Desktop did not become ready within ${startTimeoutMs / 1_000} seconds. Check Docker Desktop and retry.`,
  );
}

async function main() {
  if (await isDockerReady()) {
    console.log('[docker] Docker is already running.');
    return;
  }

  await startDockerDesktop();
  await waitForDocker();
}

main().catch((error) => {
  console.error(`[docker] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
