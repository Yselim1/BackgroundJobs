ALTER TABLE executions DROP CONSTRAINT executions_trigger_type_check;
ALTER TABLE executions ADD CONSTRAINT executions_trigger_type_check
    CHECK (trigger_type IN ('manual', 'scheduled', 'webhook', 'job_completion', 'backfill', 'test', 'replay'));

ALTER TABLE executions DROP CONSTRAINT executions_schedule_trigger_check;
ALTER TABLE executions ADD CONSTRAINT executions_schedule_trigger_check
    CHECK (
        (trigger_type IN ('scheduled', 'backfill') AND scheduled_for IS NOT NULL)
        OR (trigger_type NOT IN ('scheduled', 'backfill') AND scheduled_for IS NULL)
    );

ALTER TABLE execution_steps DROP CONSTRAINT execution_steps_status_check;
ALTER TABLE execution_steps ADD CONSTRAINT execution_steps_status_check
    CHECK (status IN ('pending', 'running', 'success', 'failed', 'skipped', 'cancelled', 'reused'));

ALTER TABLE executions
    ADD COLUMN replay_source_execution_id uuid REFERENCES executions(id) ON DELETE SET NULL,
    ADD COLUMN resume_step_id text,
    ADD CONSTRAINT executions_replay_lineage_check CHECK (
        (trigger_type = 'replay' AND replay_source_execution_id IS NOT NULL)
        OR (trigger_type <> 'replay' AND replay_source_execution_id IS NULL AND resume_step_id IS NULL)
    );

CREATE INDEX executions_replay_source_idx
    ON executions (replay_source_execution_id, requested_at DESC)
    WHERE replay_source_execution_id IS NOT NULL;

CREATE TABLE execution_idempotency (
    actor_scope_hash bytea NOT NULL,
    job_id text NOT NULL,
    operation text NOT NULL CHECK (operation IN ('manual_run', 'backfill')),
    key_hash bytea NOT NULL,
    request_hash bytea NOT NULL,
    execution_id uuid REFERENCES executions(id) ON DELETE CASCADE,
    response_snapshot jsonb,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (actor_scope_hash, job_id, operation, key_hash),
    CHECK (execution_id IS NOT NULL OR response_snapshot IS NOT NULL)
);

CREATE INDEX execution_idempotency_execution_idx
    ON execution_idempotency (execution_id)
    WHERE execution_id IS NOT NULL;
