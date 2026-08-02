-- Activity charts query execution rows directly. These indexes keep the fixed
-- 6-hour, 24-hour, and 7-day windows efficient without introducing telemetry.
CREATE INDEX executions_activity_finished_idx
    ON executions (finished_at DESC)
    WHERE status IN ('success', 'failed', 'cancelled', 'skipped');

CREATE INDEX executions_queue_delay_idx
    ON executions (requested_at DESC, started_at)
    WHERE started_at IS NOT NULL;
