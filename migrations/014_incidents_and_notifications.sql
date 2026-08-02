ALTER TABLE operational_attention_items
    DROP CONSTRAINT operational_attention_items_state_check,
    DROP CONSTRAINT operational_attention_items_resolution_action_check,
    DROP CONSTRAINT operational_attention_items_check1;

ALTER TABLE operational_attention_items
    ADD COLUMN severity text NOT NULL DEFAULT 'high'
        CHECK (severity IN ('critical', 'high', 'medium', 'low')),
    ADD COLUMN assignee_user_id uuid REFERENCES security_users(id) ON DELETE SET NULL,
    ADD COLUMN snoozed_until timestamptz,
    ADD COLUMN resolution_note text,
    ADD COLUMN fingerprint text,
    ADD COLUMN occurrence_count integer NOT NULL DEFAULT 1 CHECK (occurrence_count > 0),
    ADD COLUMN last_occurred_at timestamptz;

UPDATE operational_attention_items
SET fingerprint = md5(kind || ':' || source_id::text),
    last_occurred_at = occurred_at;

ALTER TABLE operational_attention_items
    ALTER COLUMN fingerprint SET NOT NULL,
    ALTER COLUMN last_occurred_at SET NOT NULL,
    ADD CONSTRAINT operational_attention_items_state_check
        CHECK (state IN ('open', 'acknowledged', 'snoozed', 'ignored', 'resolved')),
    ADD CONSTRAINT operational_attention_items_resolution_action_check
        CHECK (resolution_action IN ('rerun', 'webhook_retry', 'manual')),
    ADD CONSTRAINT operational_attention_items_snooze_check
        CHECK ((state = 'snoozed' AND snoozed_until IS NOT NULL) OR state <> 'snoozed'),
    ADD CONSTRAINT operational_attention_items_resolution_check
        CHECK (
            (state = 'resolved' AND resolution_action IS NOT NULL AND resolution_details IS NOT NULL)
            OR (state <> 'resolved' AND resolution_action IS NULL AND resolution_details IS NULL)
        );

CREATE UNIQUE INDEX operational_attention_fingerprint_uidx
    ON operational_attention_items (fingerprint);
CREATE INDEX operational_attention_assignee_idx
    ON operational_attention_items (assignee_user_id, state, last_occurred_at DESC);
CREATE INDEX operational_attention_severity_idx
    ON operational_attention_items (severity, state, last_occurred_at DESC);

CREATE TABLE incident_events (
    id bigserial PRIMARY KEY,
    attention_id uuid NOT NULL REFERENCES operational_attention_items(id) ON DELETE CASCADE,
    event_type text NOT NULL,
    actor_type text NOT NULL DEFAULT 'system' CHECK (actor_type IN ('system', 'user', 'api_token')),
    actor_user_id uuid REFERENCES security_users(id) ON DELETE SET NULL,
    actor_label text NOT NULL DEFAULT 'system',
    details jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX incident_events_attention_idx ON incident_events (attention_id, id);

INSERT INTO incident_events(attention_id, event_type, details, created_at)
SELECT id, 'opened', jsonb_build_object('migrated', true, 'state', state), created_at
FROM operational_attention_items;

INSERT INTO incident_events(attention_id, event_type, actor_type, actor_user_id, actor_label, details, created_at)
SELECT id, 'state_changed', coalesce(state_changed_by_type, 'system'), state_changed_by_user_id,
       coalesce(state_changed_by_label, 'system'), jsonb_build_object('state', state, 'migrated', true),
       coalesce(state_changed_at, updated_at)
FROM operational_attention_items
WHERE state <> 'open';

CREATE TABLE notification_channels (
    id uuid PRIMARY KEY,
    name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
    kind text NOT NULL CHECK (kind IN ('generic_webhook', 'slack')),
    endpoint_secret_name text NOT NULL REFERENCES managed_secrets(name),
    signing_secret_name text REFERENCES managed_secrets(name),
    enabled boolean NOT NULL DEFAULT true,
    version integer NOT NULL DEFAULT 1 CHECK (version > 0),
    created_by_user_id uuid REFERENCES security_users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK ((kind = 'generic_webhook' AND signing_secret_name IS NOT NULL) OR kind = 'slack')
);

CREATE TABLE notification_policies (
    id uuid PRIMARY KEY,
    name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
    channel_id uuid NOT NULL REFERENCES notification_channels(id) ON DELETE CASCADE,
    enabled boolean NOT NULL DEFAULT true,
    incident_kinds text[] NOT NULL DEFAULT ARRAY['execution_failure', 'webhook_failure']::text[],
    minimum_severity text NOT NULL DEFAULT 'high' CHECK (minimum_severity IN ('critical', 'high', 'medium', 'low')),
    job_ids text[],
    lifecycle_events text[] NOT NULL DEFAULT ARRAY['opened', 'reopened', 'severity_increased', 'resolved']::text[],
    version integer NOT NULL DEFAULT 1 CHECK (version > 0),
    created_by_user_id uuid REFERENCES security_users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (cardinality(incident_kinds) > 0),
    CHECK (incident_kinds <@ ARRAY['execution_failure', 'webhook_failure']::text[]),
    CHECK (cardinality(lifecycle_events) > 0),
    CHECK (lifecycle_events <@ ARRAY['opened', 'reopened', 'severity_increased', 'resolved']::text[])
);

CREATE TABLE notification_deliveries (
    id uuid PRIMARY KEY,
    incident_event_id bigint NOT NULL REFERENCES incident_events(id) ON DELETE CASCADE,
    channel_id uuid NOT NULL REFERENCES notification_channels(id) ON DELETE CASCADE,
    policy_id uuid NOT NULL REFERENCES notification_policies(id) ON DELETE CASCADE,
    payload jsonb NOT NULL,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivering', 'success', 'failed')),
    attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    response_status integer,
    last_error text,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    delivered_at timestamptz,
    UNIQUE (incident_event_id, policy_id)
);

CREATE INDEX notification_deliveries_due_idx
    ON notification_deliveries(next_attempt_at, created_at)
    WHERE status = 'pending';
