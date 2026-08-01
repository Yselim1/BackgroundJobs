CREATE TABLE worker_instances (
    id uuid PRIMARY KEY,
    name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
    queues text[] NOT NULL DEFAULT ARRAY['default']::text[],
    concurrency integer NOT NULL CHECK (concurrency > 0),
    desired_state text NOT NULL DEFAULT 'accepting' CHECK (desired_state IN ('accepting', 'draining')),
    started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    last_heartbeat_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    stopped_at timestamptz,
    CHECK (cardinality(queues) > 0)
);

CREATE INDEX worker_instances_heartbeat_idx ON worker_instances (last_heartbeat_at DESC);

DROP INDEX executions_one_active_per_job_uidx;
CREATE UNIQUE INDEX executions_one_running_per_job_uidx
    ON executions (job_id)
    WHERE status = 'running';

ALTER TABLE executions
    ADD COLUMN queue_name text NOT NULL DEFAULT 'default',
    ADD COLUMN priority integer NOT NULL DEFAULT 0 CHECK (priority BETWEEN -100 AND 100),
    ADD COLUMN claimed_by_worker_id uuid REFERENCES worker_instances(id) ON DELETE SET NULL,
    ADD COLUMN lease_expires_at timestamptz;

ALTER TABLE executions
    ADD CONSTRAINT executions_queue_name_check CHECK (queue_name ~ '^[a-z][a-z0-9_-]{0,63}$'),
    ADD CONSTRAINT executions_lease_owner_check CHECK (
        (status = 'running' AND claimed_by_worker_id IS NOT NULL AND lease_expires_at IS NOT NULL)
        OR status <> 'running'
    ) NOT VALID;

CREATE INDEX executions_queue_claim_idx
    ON executions (queue_name, priority DESC, requested_at, id)
    WHERE status = 'queued';

CREATE INDEX executions_lease_idx
    ON executions (lease_expires_at)
    WHERE status = 'running';
