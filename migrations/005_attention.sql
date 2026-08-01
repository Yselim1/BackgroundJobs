CREATE TABLE operational_attention_items (
    id uuid PRIMARY KEY,
    kind text NOT NULL CHECK (kind IN ('execution_failure', 'webhook_failure')),
    source_id uuid NOT NULL,
    execution_id uuid NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
    job_id text NOT NULL,
    reason text NOT NULL,
    detail_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
    occurred_at timestamptz NOT NULL,
    state text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'ignored', 'resolved')),
    state_changed_by_type text CHECK (state_changed_by_type IN ('user', 'api_token', 'system')),
    state_changed_by_user_id uuid REFERENCES security_users(id) ON DELETE SET NULL,
    state_changed_by_label text,
    state_changed_at timestamptz,
    resolution_action text CHECK (resolution_action IN ('rerun', 'webhook_retry')),
    resolution_details jsonb,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT operational_attention_source_uidx UNIQUE (kind, source_id),
    CHECK (
        (state_changed_at IS NULL AND state_changed_by_type IS NULL AND state_changed_by_label IS NULL)
        OR state_changed_at IS NOT NULL
    ),
    CHECK (
        (state = 'resolved' AND resolution_action IS NOT NULL AND resolution_details IS NOT NULL)
        OR (state <> 'resolved' AND resolution_action IS NULL AND resolution_details IS NULL)
    )
);

CREATE INDEX operational_attention_state_idx
    ON operational_attention_items (state);

CREATE INDEX operational_attention_kind_idx
    ON operational_attention_items (kind);

CREATE INDEX operational_attention_newest_idx
    ON operational_attention_items (occurred_at DESC, id DESC);

CREATE INDEX operational_attention_state_newest_idx
    ON operational_attention_items (state, occurred_at DESC, id DESC);

INSERT INTO operational_attention_items(
    id, kind, source_id, execution_id, job_id, reason, detail_snapshot, occurred_at
)
SELECT
    overlay(
        overlay(md5('execution_failure:' || e.id::text) placing '5' from 13 for 1)
        placing 'a' from 17 for 1
    )::uuid,
    'execution_failure',
    e.id,
    e.id,
    e.job_id,
    coalesce(e.error_message, 'Execution failed without an error message.'),
    jsonb_build_object(
        'errorCode', e.error_code,
        'error', e.error_message,
        'trigger', e.trigger_type,
        'input', e.input
    ),
    coalesce(e.finished_at, e.requested_at)
FROM executions e
WHERE e.status = 'failed'
  AND coalesce(e.finished_at, e.requested_at) >= clock_timestamp() - interval '24 hours'
ON CONFLICT (kind, source_id) DO NOTHING;

INSERT INTO operational_attention_items(
    id, kind, source_id, execution_id, job_id, reason, detail_snapshot, occurred_at
)
SELECT
    overlay(
        overlay(md5('webhook_failure:' || w.id::text) placing '5' from 13 for 1)
        placing 'a' from 17 for 1
    )::uuid,
    'webhook_failure',
    w.id,
    w.execution_id,
    e.job_id,
    coalesce(w.last_error, 'Webhook delivery failed without an error message.'),
    jsonb_build_object(
        'deliveryId', w.id,
        'eventType', w.event_type,
        'url', w.url,
        'attemptCount', w.attempt_count,
        'responseStatus', w.response_status,
        'lastError', w.last_error
    ),
    w.updated_at
FROM webhook_deliveries w
JOIN executions e ON e.id = w.execution_id
WHERE w.status = 'failed'
ON CONFLICT (kind, source_id) DO NOTHING;
