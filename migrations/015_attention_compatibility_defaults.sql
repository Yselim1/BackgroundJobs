-- Preserve compatibility for integrations that insert Attention rows directly.
-- Repository-created incidents always provide deterministic fingerprints; this
-- fallback only gives legacy writers a collision-resistant grouping identity.
ALTER TABLE operational_attention_items
    ALTER COLUMN fingerprint SET DEFAULT md5(
        random()::text || clock_timestamp()::text || pg_backend_pid()::text
    ),
    ALTER COLUMN last_occurred_at SET DEFAULT clock_timestamp();
