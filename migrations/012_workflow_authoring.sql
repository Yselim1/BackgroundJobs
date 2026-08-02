ALTER TABLE executions
    ADD COLUMN test_selected_step_id text,
    ADD COLUMN suppress_side_effects boolean NOT NULL DEFAULT false,
    ADD CONSTRAINT executions_test_shape_check CHECK (
        (trigger_type = 'test' AND test_selected_step_id IS NOT NULL AND suppress_side_effects)
        OR (trigger_type <> 'test' AND test_selected_step_id IS NULL)
    );

CREATE INDEX executions_test_requested_idx
    ON executions (requested_at DESC)
    WHERE trigger_type = 'test';
