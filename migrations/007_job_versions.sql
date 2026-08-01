CREATE TABLE job_versions (
    job_id text NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    version integer NOT NULL CHECK (version > 0),
    definition jsonb NOT NULL,
    change_type text NOT NULL CHECK (change_type IN ('create', 'update', 'status', 'rollback', 'import')),
    created_by_type text NOT NULL DEFAULT 'system' CHECK (created_by_type IN ('system', 'user', 'api_token')),
    created_by_user_id uuid REFERENCES security_users(id) ON DELETE SET NULL,
    created_by_label text NOT NULL DEFAULT 'system',
    restored_from_version integer CHECK (restored_from_version IS NULL OR restored_from_version > 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (job_id, version)
);

CREATE INDEX job_versions_newest_idx ON job_versions (job_id, version DESC);

CREATE FUNCTION prevent_job_version_update() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'job versions are immutable';
END;
$$;

CREATE TRIGGER job_versions_immutable
BEFORE UPDATE ON job_versions
FOR EACH ROW EXECUTE FUNCTION prevent_job_version_update();

ALTER TABLE jobs ADD COLUMN current_version integer NOT NULL DEFAULT 1 CHECK (current_version > 0);
ALTER TABLE executions ADD COLUMN job_version integer CHECK (job_version IS NULL OR job_version > 0);

INSERT INTO job_versions(job_id, version, definition, change_type)
SELECT id, 1, definition, 'import'
FROM jobs;

UPDATE executions e
SET job_version = 1
FROM jobs j
WHERE j.id = e.job_id AND e.job_definition = j.definition;
