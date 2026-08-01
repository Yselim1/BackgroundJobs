ALTER TABLE security_users
    ADD COLUMN password_change_required boolean NOT NULL DEFAULT false;

ALTER TABLE managed_secrets
    ADD COLUMN owner_user_id uuid REFERENCES security_users(id) ON DELETE SET NULL,
    ADD COLUMN last_rotated_by_user_id uuid REFERENCES security_users(id) ON DELETE SET NULL,
    ADD COLUMN expires_on date;

UPDATE managed_secrets
SET owner_user_id = created_by_user_id
WHERE owner_user_id IS NULL;

CREATE INDEX managed_secrets_owner_idx
    ON managed_secrets (owner_user_id, name);

CREATE INDEX managed_secrets_expiry_idx
    ON managed_secrets (expires_on, name)
    WHERE expires_on IS NOT NULL;
