CREATE TABLE security_users (
    id uuid PRIMARY KEY,
    email text NOT NULL,
    display_name text NOT NULL,
    password_hash text NOT NULL,
    role text NOT NULL CHECK (role IN ('viewer', 'operator', 'admin')),
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
    failed_login_attempts integer NOT NULL DEFAULT 0 CHECK (failed_login_attempts >= 0),
    locked_until timestamptz,
    last_login_at timestamptz,
    password_changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE UNIQUE INDEX security_users_email_uidx ON security_users (lower(email));
CREATE INDEX security_users_role_status_idx ON security_users (role, status);

CREATE TABLE security_sessions (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES security_users(id) ON DELETE CASCADE,
    token_hash bytea NOT NULL UNIQUE,
    csrf_token_hash bytea NOT NULL,
    expires_at timestamptz NOT NULL,
    idle_expires_at timestamptz NOT NULL,
    last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    ip_address inet,
    user_agent text,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (idle_expires_at <= expires_at)
);

CREATE INDEX security_sessions_user_idx ON security_sessions (user_id, created_at DESC);
CREATE INDEX security_sessions_expiry_idx ON security_sessions (expires_at);

CREATE TABLE security_api_tokens (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES security_users(id) ON DELETE CASCADE,
    name text NOT NULL,
    token_hash bytea NOT NULL UNIQUE,
    expires_at timestamptz,
    last_used_at timestamptz,
    revoked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (length(name) BETWEEN 1 AND 100)
);

CREATE INDEX security_api_tokens_user_idx ON security_api_tokens (user_id, created_at DESC);

CREATE TABLE managed_secrets (
    id uuid PRIMARY KEY,
    name text NOT NULL UNIQUE,
    description text,
    encrypted_value bytea NOT NULL,
    nonce bytea NOT NULL,
    auth_tag bytea NOT NULL,
    key_version integer NOT NULL DEFAULT 1 CHECK (key_version > 0),
    created_by_user_id uuid REFERENCES security_users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (name ~ '^[A-Z][A-Z0-9_]{1,63}$')
);

CREATE TABLE security_audit_events (
    id bigserial PRIMARY KEY,
    request_id uuid NOT NULL,
    actor_type text NOT NULL CHECK (actor_type IN ('anonymous', 'user', 'api_token', 'system')),
    actor_user_id uuid REFERENCES security_users(id) ON DELETE SET NULL,
    actor_label text NOT NULL,
    action text NOT NULL,
    outcome text NOT NULL CHECK (outcome IN ('success', 'failure')),
    status_code integer NOT NULL CHECK (status_code BETWEEN 100 AND 599),
    resource_type text,
    resource_id text,
    ip_address inet,
    user_agent text,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX security_audit_created_idx ON security_audit_events (created_at DESC, id DESC);
CREATE INDEX security_audit_actor_idx ON security_audit_events (actor_user_id, created_at DESC, id DESC);
CREATE INDEX security_audit_action_idx ON security_audit_events (action, created_at DESC, id DESC);

CREATE FUNCTION prevent_security_audit_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'security audit events are append-only';
END;
$$;

CREATE TRIGGER security_audit_events_immutable
BEFORE UPDATE OR DELETE ON security_audit_events
FOR EACH ROW EXECUTE FUNCTION prevent_security_audit_mutation();

ALTER TABLE executions
    ADD COLUMN requested_by_type text NOT NULL DEFAULT 'system'
        CHECK (requested_by_type IN ('system', 'user', 'api_token')),
    ADD COLUMN requested_by_user_id uuid REFERENCES security_users(id) ON DELETE SET NULL,
    ADD COLUMN requested_by_label text NOT NULL DEFAULT 'system',
    ADD COLUMN cancel_requested_by_type text
        CHECK (cancel_requested_by_type IN ('user', 'api_token')),
    ADD COLUMN cancel_requested_by_user_id uuid REFERENCES security_users(id) ON DELETE SET NULL,
    ADD COLUMN cancel_requested_by_label text;

ALTER TABLE webhook_deliveries
    ADD COLUMN signing_secret_name text;
