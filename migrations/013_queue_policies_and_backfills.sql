CREATE TABLE queue_policies (
    name text PRIMARY KEY CHECK (name ~ '^[a-z][a-z0-9_-]{0,63}$'),
    paused boolean NOT NULL DEFAULT false,
    max_running integer CHECK (max_running IS NULL OR max_running > 0),
    max_starts integer CHECK (max_starts IS NULL OR max_starts > 0),
    interval_ms integer CHECK (interval_ms IS NULL OR interval_ms BETWEEN 1000 AND 86400000),
    version integer NOT NULL DEFAULT 1 CHECK (version > 0),
    updated_by_user_id uuid REFERENCES security_users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK ((max_starts IS NULL AND interval_ms IS NULL) OR (max_starts IS NOT NULL AND interval_ms IS NOT NULL))
);

INSERT INTO queue_policies(name)
SELECT DISTINCT queue_name FROM executions
ON CONFLICT DO NOTHING;

CREATE TABLE queue_rate_windows (
    queue_name text NOT NULL REFERENCES queue_policies(name) ON DELETE CASCADE,
    window_started_at timestamptz NOT NULL,
    starts_count integer NOT NULL DEFAULT 0 CHECK (starts_count >= 0),
    PRIMARY KEY (queue_name, window_started_at)
);

ALTER TABLE executions
    ADD COLUMN concurrency_key text;

DROP INDEX executions_one_running_per_job_uidx;
DROP INDEX executions_scheduled_occurrence_uidx;
CREATE UNIQUE INDEX executions_scheduled_occurrence_uidx
    ON executions (job_id, scheduled_for)
    WHERE trigger_type IN ('scheduled', 'backfill');

CREATE INDEX executions_job_concurrency_idx
    ON executions (job_id, concurrency_key, status)
    WHERE status = 'running';
