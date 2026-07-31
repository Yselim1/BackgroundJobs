export type ExecutionStatus = 'queued' | 'running' | 'success' | 'failed' | 'cancelled' | 'skipped';

export interface PlatformOverview {
    generatedAt: string;
    jobs: { total: number; active: number; inactive: number };
    executions: {
        queued: number;
        running: number;
        success24h: number;
        failed24h: number;
        cancelled24h: number;
        skipped24h: number;
        averageSuccessDurationMs24h: number | null;
    };
    webhooks: { pending: number; delivering: number; failed: number };
}

export interface JobStep {
    ID: string;
    NAME: string;
    TYPE: string;
    WHEN?: { PATH: string };
    FOREACH?: { ITEMS: string; MAX_CONCURRENCY?: number };
}

export interface Job {
    id: string;
    name: string;
    status: 'active' | 'inactive';
    schedule?: string;
    timezone: string;
    next_run: string | null;
    last_run: string | null;
    STEPS: JobStep[];
}

export interface ExecutionSummary {
    executionId: string;
    jobId: string;
    trigger: 'manual' | 'scheduled';
    status: ExecutionStatus;
    requestedAt: string;
    startedAt: string | null;
    finishedAt: string | null;
    durationMs: number | null;
    error: { code: string | null; message: string } | null;
    skipReason: string | null;
}

export interface StepAttempt {
    attempt: number;
    itemIndex?: number;
    status: string;
    durationMs?: number;
    error?: string;
}

export interface StepResult {
    stepId: string;
    stepName: string;
    stepType: string;
    status: string;
    durationMs?: number;
    attempts: StepAttempt[];
    reason?: string;
    error?: string;
}

export interface ExecutionDetail extends ExecutionSummary {
    input: Record<string, unknown>;
    stepResults: Record<string, StepResult>;
}

export interface ExecutionPage {
    items: ExecutionSummary[];
    nextCursor: string | null;
}
