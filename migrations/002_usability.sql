ALTER TABLE executions
    ADD COLUMN input jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE execution_events (
    id bigserial PRIMARY KEY,
    execution_id uuid NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
    event_type text NOT NULL,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX execution_events_execution_id_idx
    ON execution_events (execution_id, id);

CREATE TABLE webhook_deliveries (
    id uuid PRIMARY KEY,
    execution_id uuid NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
    event_type text NOT NULL,
    subscription_index integer NOT NULL,
    url text NOT NULL,
    payload jsonb NOT NULL,
    status text NOT NULL CHECK (status IN ('pending', 'delivering', 'success', 'failed')),
    attempt_count integer NOT NULL DEFAULT 0,
    next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    response_status integer,
    last_error text,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    delivered_at timestamptz,
    UNIQUE (execution_id, event_type, subscription_index),
    CHECK (subscription_index >= 0),
    CHECK (attempt_count >= 0)
);

CREATE INDEX webhook_deliveries_due_idx
    ON webhook_deliveries (next_attempt_at, created_at)
    WHERE status = 'pending';

CREATE INDEX webhook_deliveries_execution_idx
    ON webhook_deliveries (execution_id, created_at);
