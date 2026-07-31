CREATE TABLE jobs (
    id text PRIMARY KEY,
    definition jsonb NOT NULL,
    status text NOT NULL CHECK (status IN ('active', 'inactive')),
    schedule text,
    timezone text NOT NULL DEFAULT 'UTC',
    last_run_at timestamptz,
    next_run_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (schedule IS NOT NULL OR next_run_at IS NULL),
    CHECK (status = 'active' OR next_run_at IS NULL)
);

CREATE INDEX jobs_status_idx ON jobs (status);
CREATE INDEX jobs_due_idx ON jobs (next_run_at) WHERE status = 'active' AND next_run_at IS NOT NULL;

CREATE TABLE executions (
    id uuid PRIMARY KEY,
    job_id text NOT NULL,
    job_definition jsonb NOT NULL,
    trigger_type text NOT NULL CHECK (trigger_type IN ('manual', 'scheduled')),
    status text NOT NULL CHECK (status IN ('queued', 'running', 'success', 'failed', 'cancelled', 'skipped')),
    scheduled_for timestamptz,
    requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    started_at timestamptz,
    finished_at timestamptz,
    cancel_requested_at timestamptz,
    duration_ms bigint,
    error_code text,
    error_message text,
    skip_reason text,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK ((trigger_type = 'scheduled' AND scheduled_for IS NOT NULL) OR trigger_type = 'manual'),
    CHECK (duration_ms IS NULL OR duration_ms >= 0)
);

CREATE UNIQUE INDEX executions_scheduled_occurrence_uidx
    ON executions (job_id, scheduled_for)
    WHERE trigger_type = 'scheduled';

CREATE UNIQUE INDEX executions_one_active_per_job_uidx
    ON executions (job_id)
    WHERE status IN ('queued', 'running');

CREATE INDEX executions_requested_idx ON executions (requested_at DESC, id DESC);
CREATE INDEX executions_job_requested_idx ON executions (job_id, requested_at DESC, id DESC);
CREATE INDEX executions_status_requested_idx ON executions (status, requested_at DESC, id DESC);

CREATE TABLE execution_steps (
    execution_id uuid NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
    step_id text NOT NULL,
    step_name text NOT NULL,
    step_type text NOT NULL,
    step_order integer NOT NULL,
    status text NOT NULL CHECK (status IN ('pending', 'running', 'success', 'failed', 'skipped', 'cancelled')),
    started_at timestamptz,
    finished_at timestamptz,
    duration_ms bigint,
    output jsonb,
    error_code text,
    error_message text,
    reason text,
    PRIMARY KEY (execution_id, step_id),
    CHECK (duration_ms IS NULL OR duration_ms >= 0)
);

CREATE INDEX execution_steps_execution_order_idx ON execution_steps (execution_id, step_order);

CREATE TABLE execution_attempts (
    execution_id uuid NOT NULL,
    step_id text NOT NULL,
    attempt integer NOT NULL,
    status text NOT NULL CHECK (status IN ('running', 'success', 'failed', 'cancelled')),
    started_at timestamptz NOT NULL,
    finished_at timestamptz,
    duration_ms bigint,
    error_code text,
    error_message text,
    PRIMARY KEY (execution_id, step_id, attempt),
    FOREIGN KEY (execution_id, step_id)
        REFERENCES execution_steps(execution_id, step_id) ON DELETE CASCADE,
    CHECK (attempt > 0),
    CHECK (duration_ms IS NULL OR duration_ms >= 0)
);
