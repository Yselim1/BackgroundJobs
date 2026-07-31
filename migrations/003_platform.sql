ALTER TABLE execution_attempts
    ADD COLUMN item_index integer NOT NULL DEFAULT -1;

ALTER TABLE execution_attempts
    DROP CONSTRAINT execution_attempts_pkey;

ALTER TABLE execution_attempts
    ADD PRIMARY KEY (execution_id, step_id, item_index, attempt),
    ADD CONSTRAINT execution_attempts_item_index_check CHECK (item_index >= -1);
