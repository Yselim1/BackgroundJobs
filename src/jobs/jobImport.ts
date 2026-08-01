import type { Job, ValidationIssue } from '../types/index.js';
import { validateJobDefinition } from '../utils/jobValidator.js';

const READ_ONLY_FIELDS = ['last_run', 'next_run', 'created_at', 'updated_at'] as const;

export interface JobImportStats {
    totalJobs: number;
    schedulesConverted: number;
    timezonesDefaulted: number;
    statusesSetInactive: number;
    readOnlyFieldsRemoved: number;
    legacyRetriesConverted: number;
}

export type JobImportPreparation =
    | { valid: true; jobs: Job[]; errors: []; stats: JobImportStats }
    | { valid: false; errors: ValidationIssue[]; stats: JobImportStats };

export function prepareJobImport(input: unknown): JobImportPreparation {
    const stats: JobImportStats = {
        totalJobs: Array.isArray(input) ? input.length : 0,
        schedulesConverted: 0,
        timezonesDefaulted: 0,
        statusesSetInactive: 0,
        readOnlyFieldsRemoved: 0,
        legacyRetriesConverted: 0
    };
    if (!Array.isArray(input)) {
        return {
            valid: false,
            errors: [{
                path: '$',
                code: 'IMPORT_ARRAY_REQUIRED',
                message: 'The import file must contain a JSON array of job definitions.'
            }],
            stats
        };
    }

    const jobs: Job[] = [];
    const errors: ValidationIssue[] = [];
    const encounteredIds = new Map<string, number>();

    input.forEach((value, index) => {
        if (!isRecord(value)) {
            errors.push({
                path: `[${index}]`,
                code: 'INVALID_JOB',
                message: 'Each imported item must be a job definition object.'
            });
            return;
        }

        const candidate: Record<string, unknown> = { ...value };
        for (const field of READ_ONLY_FIELDS) {
            if (Object.hasOwn(candidate, field)) {
                delete candidate[field];
                stats.readOnlyFieldsRemoved++;
            }
        }

        if (typeof candidate.schedule === 'string') {
            const fields = candidate.schedule.trim().split(/\s+/u);
            if (fields.length === 5) {
                candidate.schedule = `0 ${fields.join(' ')}`;
                stats.schedulesConverted++;
            }
        }

        if (candidate.timezone === undefined) {
            candidate.timezone = 'UTC';
            stats.timezonesDefaulted++;
        }
        if (candidate.status !== 'inactive') {
            stats.statusesSetInactive++;
        }
        candidate.status = 'inactive';

        if (Object.hasOwn(candidate, 'maxRetries')) {
            const maxRetries = candidate.maxRetries;
            if (candidate.DEFAULT_STEP_RETRY !== undefined) {
                errors.push({
                    path: `[${index}].maxRetries`,
                    code: 'CONFLICTING_RETRY_SETTINGS',
                    message: 'maxRetries cannot be combined with DEFAULT_STEP_RETRY.'
                });
            } else if (typeof maxRetries !== 'number' || !Number.isInteger(maxRetries) || maxRetries < 0) {
                errors.push({
                    path: `[${index}].maxRetries`,
                    code: 'INVALID_LEGACY_MAX_RETRIES',
                    message: 'maxRetries must be a non-negative integer.'
                });
            } else {
                candidate.DEFAULT_STEP_RETRY = { MAX_ATTEMPTS: maxRetries + 1 };
                stats.legacyRetriesConverted++;
            }
            delete candidate.maxRetries;
        }

        const validation = validateJobDefinition(candidate);
        if (!validation.valid) {
            errors.push(...validation.errors.map(issue => ({
                ...issue,
                path: issue.path === '$' ? `[${index}]` : `[${index}].${issue.path}`
            })));
            return;
        }

        const previousIndex = encounteredIds.get(validation.job.id);
        if (previousIndex !== undefined) {
            errors.push({
                path: `[${index}].id`,
                code: 'DUPLICATE_IMPORT_JOB_ID',
                message: `Job ID "${validation.job.id}" duplicates item ${previousIndex}.`
            });
            return;
        }
        encounteredIds.set(validation.job.id, index);
        jobs.push(validation.job);
    });

    if (errors.length > 0) return { valid: false, errors, stats };
    return { valid: true, jobs, errors: [], stats };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
