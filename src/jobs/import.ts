import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../config.js';
import { assertSchemaCurrent } from '../db/migrations.js';
import { createPool } from '../db/pool.js';
import { AuditRepository } from '../repositories/AuditRepository.js';
import { JobRepository } from '../repositories/JobRepository.js';
import { prepareJobImport, type JobImportStats } from './jobImport.js';

interface ImportOptions {
    sourcePath: string;
    mode: 'dry-run' | 'apply';
}

async function main(): Promise<void> {
    const options = parseArguments(process.argv.slice(2));
    if (options === undefined) return;

    const absoluteSource = path.resolve(process.cwd(), options.sourcePath);
    const source = await readImportFile(absoluteSource);
    const prepared = prepareJobImport(source);
    if (!prepared.valid) {
        const details = prepared.errors.map(issue =>
            `  - ${issue.path} [${issue.code}]: ${issue.message}`
        ).join('\n');
        throw new Error(`Import validation failed with ${prepared.errors.length} issue(s):\n${details}`);
    }

    const config = loadConfig();
    const pool = createPool(config.databaseUrl, config.dbPoolMax);
    try {
        await assertSchemaCurrent(pool);
        const jobs = new JobRepository(pool);
        const existingIds = await jobs.findExistingIds(prepared.jobs.map(job => job.id));
        printPreview(absoluteSource, prepared.stats);
        if (existingIds.length > 0) {
            throw new Error(
                'Import refused because these job IDs already exist in PostgreSQL: ' +
                existingIds.join(', ')
            );
        }

        if (options.mode === 'dry-run') {
            console.log('Dry run complete. No jobs were written to PostgreSQL.');
            return;
        }

        const imported = await jobs.createMany(prepared.jobs);
        try {
            await new AuditRepository(pool).record({
                requestId: randomUUID(),
                actorType: 'system',
                actorLabel: 'jobs:import',
                action: 'job.import',
                outcome: 'success',
                statusCode: 201,
                resourceType: 'job_import',
                metadata: {
                    sourceFile: path.basename(absoluteSource),
                    importedCount: imported.length,
                    importedStatus: 'inactive'
                }
            });
        } catch (error: unknown) {
            console.warn(
                'Jobs were imported, but the audit event could not be recorded:',
                error instanceof Error ? error.message : String(error)
            );
        }
        console.log(`Imported ${imported.length} inactive job(s) into PostgreSQL.`);
    } finally {
        await pool.end();
    }
}

function parseArguments(args: string[]): ImportOptions | undefined {
    if (args.includes('--help') || args.includes('-h')) {
        printUsage();
        return undefined;
    }
    const supportedFlags = new Set(['--dry-run', '--apply']);
    const unknownFlag = args.find(argument => argument.startsWith('-') && !supportedFlags.has(argument));
    if (unknownFlag !== undefined) throw new Error(`Unknown option: ${unknownFlag}`);

    const sourcePaths = args.filter(argument => !argument.startsWith('-'));
    if (sourcePaths.length !== 1) {
        throw new Error('Provide exactly one JSON file path.');
    }
    const dryRun = args.includes('--dry-run');
    const apply = args.includes('--apply');
    if (dryRun === apply) {
        throw new Error('Choose exactly one mode: --dry-run or --apply.');
    }
    return {
        sourcePath: sourcePaths[0]!,
        mode: apply ? 'apply' : 'dry-run'
    };
}

async function readImportFile(sourcePath: string): Promise<unknown> {
    let contents: string;
    try {
        contents = await fs.readFile(sourcePath, 'utf8');
    } catch (error: unknown) {
        throw new Error(
            `Cannot read import file "${sourcePath}": ${error instanceof Error ? error.message : String(error)}`
        );
    }
    try {
        return JSON.parse(contents) as unknown;
    } catch (error: unknown) {
        throw new Error(
            `Import file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
        );
    }
}

function printPreview(sourcePath: string, stats: JobImportStats): void {
    console.log('Job import preview');
    console.log('  Source:', sourcePath);
    console.log('  Jobs:', stats.totalJobs);
    console.log('  Five-field schedules converted:', stats.schedulesConverted);
    console.log('  UTC timezones added:', stats.timezonesDefaulted);
    console.log('  Jobs set inactive:', stats.statusesSetInactive);
    console.log('  Read-only fields removed:', stats.readOnlyFieldsRemoved);
    console.log('  Legacy retry policies converted:', stats.legacyRetriesConverted);
}

function printUsage(): void {
    console.log('Usage: npm run jobs:import -- <jobs.json> (--dry-run|--apply)');
    console.log('Imported jobs are always stored as inactive for review.');
}

main().catch((error: unknown) => {
    console.error('Job import failed:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
