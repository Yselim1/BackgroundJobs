ALTER TABLE executions DROP CONSTRAINT executions_trigger_type_check;
ALTER TABLE executions ADD CONSTRAINT executions_trigger_type_check
    CHECK (trigger_type IN ('manual', 'scheduled', 'webhook', 'job_completion'));
ALTER TABLE executions DROP CONSTRAINT executions_check;
ALTER TABLE executions ADD CONSTRAINT executions_schedule_trigger_check
    CHECK (
        (trigger_type = 'scheduled' AND scheduled_for IS NOT NULL)
        OR (trigger_type <> 'scheduled' AND scheduled_for IS NULL)
    );

CREATE TABLE automation_triggers (
    id uuid PRIMARY KEY,
    target_job_id text NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind IN ('webhook', 'job_completion')),
    name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
    enabled boolean NOT NULL DEFAULT true,
    source_job_id text REFERENCES jobs(id) ON DELETE CASCADE,
    terminal_statuses text[],
    token_hash bytea,
    token_suffix text,
    created_by_user_id uuid REFERENCES security_users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    last_triggered_at timestamptz,
    CHECK (
        (kind = 'webhook' AND source_job_id IS NULL AND terminal_statuses IS NULL AND token_hash IS NOT NULL AND token_suffix IS NOT NULL)
        OR
        (kind = 'job_completion' AND source_job_id IS NOT NULL AND cardinality(terminal_statuses) > 0 AND token_hash IS NULL AND token_suffix IS NULL)
    ),
    CHECK (source_job_id IS NULL OR source_job_id <> target_job_id)
    ,CHECK (terminal_statuses IS NULL OR terminal_statuses <@ ARRAY['success', 'failed', 'cancelled', 'skipped']::text[])
);

CREATE UNIQUE INDEX automation_triggers_token_uidx
    ON automation_triggers(token_hash) WHERE token_hash IS NOT NULL;
CREATE INDEX automation_triggers_target_idx ON automation_triggers(target_job_id, created_at DESC);
CREATE INDEX automation_triggers_source_idx
    ON automation_triggers(source_job_id, enabled) WHERE kind = 'job_completion';

CREATE TABLE automation_trigger_events (
    id uuid PRIMARY KEY,
    trigger_id uuid NOT NULL REFERENCES automation_triggers(id) ON DELETE CASCADE,
    source_execution_id uuid REFERENCES executions(id) ON DELETE CASCADE,
    queued_execution_id uuid REFERENCES executions(id) ON DELETE SET NULL,
    idempotency_key_hash bytea,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    status text NOT NULL CHECK (status IN ('pending', 'queued', 'skipped', 'failed')),
    reason text,
    attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE UNIQUE INDEX automation_events_source_uidx
    ON automation_trigger_events(trigger_id, source_execution_id)
    WHERE source_execution_id IS NOT NULL;
CREATE UNIQUE INDEX automation_events_idempotency_uidx
    ON automation_trigger_events(trigger_id, idempotency_key_hash)
    WHERE idempotency_key_hash IS NOT NULL;
CREATE INDEX automation_events_due_idx
    ON automation_trigger_events(next_attempt_at, created_at)
    WHERE status = 'pending';
CREATE INDEX automation_events_trigger_idx
    ON automation_trigger_events(trigger_id, created_at DESC);

ALTER TABLE executions
    ADD COLUMN parent_execution_id uuid REFERENCES executions(id) ON DELETE SET NULL,
    ADD COLUMN automation_trigger_id uuid REFERENCES automation_triggers(id) ON DELETE SET NULL;
