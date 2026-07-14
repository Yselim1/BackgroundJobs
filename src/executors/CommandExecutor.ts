import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { type IStepExecutor } from './IStepExecutor.js';
import { type Step } from '../types/index.js';

const execAsync = promisify(exec);

export class CommandExecutor implements IStepExecutor {
    async execute(step: Step, context: Record<string, any>): Promise<any> {
        const params = step.STEP_PARAMS;

        const command = params?.COMMAND;
        const timeoutMs = params?.TIMEOUT_MS ?? 30000;
        const cwd = params?.CWD;
        const env = params?.ENV ?? {};

        if (!command) {
            throw new Error('COMMAND execution failed: COMMAND param is missing.');
        }

        console.log(`[COMMAND] Running shell command: ${command}`);

        try {
            const { stdout, stderr } = await execAsync(command, {
                timeout: timeoutMs,
                cwd,
                env: {
                    ...process.env,
                    ...env
                },
                maxBuffer: 1024 * 1024 * 10
            });

            return {
                exitCode: 0,
                stdout: stdout.trim(),
                stderr: stderr.trim()
            };
        } catch (error: any) {
            const exitCode = error.code;
            const signal = error.signal;
            const stdout = error.stdout?.trim?.() ?? '';
            const stderr = error.stderr?.trim?.() ?? '';

            throw new Error(
                [
                    `COMMAND execution failed.`,
                    `Exit code: ${exitCode ?? 'unknown'}`,
                    signal ? `Signal: ${signal}` : undefined,
                    stderr ? `stderr: ${stderr}` : undefined,
                    stdout ? `stdout: ${stdout}` : undefined
                ]
                    .filter(Boolean)
                    .join(' ')
            );
        }
    }
}