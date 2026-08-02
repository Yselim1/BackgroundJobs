import { loadConfig } from '../config.js';
import { ExecutionRepository } from '../repositories/ExecutionRepository.js';
import { WorkerRepository } from '../repositories/WorkerRepository.js';
import { assertSchemaCurrent } from './migrations.js';
import { createPool } from './pool.js';

interface RetentionOptions { days: number; batchSize: number; confirm: boolean; }

const config = loadConfig();
const pool = createPool(config.databaseUrl, config.dbPoolMax);

try {
    const options = parseOptions(process.argv.slice(2));
    await assertSchemaCurrent(pool);
    const cutoff = new Date(Date.now() - options.days * 24 * 60 * 60 * 1_000);
    const executions = new ExecutionRepository(pool);
    const workers = new WorkerRepository(pool, config.workerStaleMs);
    if (!options.confirm) {
        const [executionCount, workerCount] = await Promise.all([
            executions.countTerminalBefore(cutoff),
            workers.countRetiredBefore(cutoff)
        ]);
        console.log(`Dry run: ${executionCount} terminal execution(s) finished before ${cutoff.toISOString()} would be deleted.`);
        console.log(`Dry run: ${workerCount} inactive worker registration(s) last seen before ${cutoff.toISOString()} would be deleted.`);
        console.log('Run again with --confirm to delete them.');
    } else {
        let deletedExecutions = 0;
        while (true) {
            const ids = await executions.deleteTerminalBefore(cutoff, options.batchSize, false);
            deletedExecutions += ids.length;
            if (ids.length < options.batchSize) break;
        }
        let deletedWorkers = 0;
        while (true) {
            const ids = await workers.deleteRetiredBefore(cutoff, options.batchSize);
            deletedWorkers += ids.length;
            if (ids.length < options.batchSize) break;
        }
        console.log(`Deleted ${deletedExecutions} terminal execution(s) finished before ${cutoff.toISOString()}.`);
        console.log(`Deleted ${deletedWorkers} inactive worker registration(s) last seen before ${cutoff.toISOString()}.`);
    }
} catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
} finally {
    await pool.end();
}

function parseOptions(args: string[]): RetentionOptions {
    let days: number | undefined;
    let batchSize = 500;
    let confirm = false;
    for (let index = 0; index < args.length; index++) {
        const argument = args[index];
        if (argument === '--confirm') {
            confirm = true;
            continue;
        }
        if (argument === '--days' || argument === '--batch-size') {
            const value = args[++index];
            const parsed = value === undefined ? Number.NaN : Number(value);
            if (!Number.isInteger(parsed) || parsed <= 0) {
                throw new Error(`${argument} must be followed by a positive integer.`);
            }
            if (argument === '--days') days = parsed;
            else batchSize = parsed;
            continue;
        }
        throw new Error(`Unsupported argument: ${argument ?? ''}`);
    }
    if (days === undefined) {
        throw new Error('Usage: npm run retention -- --days <positive integer> [--batch-size <positive integer>] [--confirm]');
    }
    return { days, batchSize, confirm };
}
