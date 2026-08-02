# Workline product expansion

This release adds operator-facing run, investigation, workflow, queue, backfill, incident, and notification capabilities without adding telemetry collectors, analytics stores, AI services, or phone-home behavior. PostgreSQL remains authoritative. Activity charts query execution rows on demand and are never exported.

## Job definitions and execution input

Jobs may add INPUT_SCHEMA, DEFAULT_INPUT, RUN_POLICY, and per-step REPLAY_SAFE fields. INPUT_SCHEMA must be a JSON Schema 2020-12 object schema. DEFAULT_INPUT must be a complete valid input and is selected only when input is omitted; supplied input is never merged with it.

All manual, scheduled, automation, webhook, backfill, replay, and test inputs use the same server-side validator. RUN_POLICY.KEY, when present, must be a scalar path rooted at input. Existing definitions retain the scheduled skip and triggered queue overlap defaults.

Manual runs accept Idempotency-Key. Workline stores SHA-256 actor-scope, key, and normalized-request hashes rather than the raw key. An identical retry returns the original execution; a different request with the same key returns 409.

## Replay and draft tests

POST /api/executions/:id/replay replays the stored definition snapshot and original input by default. Supplying useCurrentDefinition is an explicit opt-in to the current revision.

Step resume requires a failed or cancelled source, always uses its snapshot, and requires the selected failed step to be replay-safe. Successful upstream and independent outputs are marked reused; the selected step and its transitive dependents run.

POST /api/jobs/test-run persists an administrator-authorized draft test and queues it through normal workers. It runs the selected step dependency closure and suppresses Attention, job-completion automations, terminal webhooks, and notifications. Executors may still perform real side effects, so the dashboard requires confirmation.

## Queue policies and backfills

Queue policy changes use PATCH /api/queues/:name with If-Match:

- paused prevents new claims while preserving queued and running work.
- maxRunning limits running executions on the queue.
- maxStarts and intervalMs define a fixed start-rate window and must be set or cleared together.

Workers lock the relevant policy and consume a rate slot in the same PostgreSQL transaction as the execution claim. Lowering a limit never cancels running work.

Backfill preview and apply use:

- POST /api/jobs/:id/backfills/preview
- POST /api/jobs/:id/backfills

Apply recomputes occurrences server-side, validates optional input, supports Idempotency-Key, and is limited to 500 occurrences. Scheduled and backfilled occurrences share a uniqueness rule; when a backfill already owns a scheduler occurrence, the scheduler advances without creating a duplicate.

## Incident and notification operations

Attention records group deterministic fingerprints, count repeated occurrences, and retain an append-only event timeline. States are open, acknowledged, snoozed, ignored, and resolved. Severities are critical, high, medium, and low. Active users may be assigned.

Administrators can perform individual and bulk acknowledgement, assignment, severity, snooze, ignore, restore, resolution, exact replay, step resume, and webhook retry. Existing viewers and operators retain read access; mutation remains administrator-only.

Administration → Notifications configures signed generic webhooks, Slack incoming webhooks, and policies matching incident kind, minimum severity, optional jobs, and opened, reopened, severity-increased, or resolved events.

Endpoint URLs and signing keys are managed-secret references. The durable outbox uses bounded exponential retry and supports manual retry. Delivery failures appear only in notification administration and never create Attention items. Generic signatures use X-Workline-Timestamp and X-Workline-Signature, where the signature is an HMAC-SHA256 of timestamp, a period, and the raw body.

Notification polling, attempts, and request timeouts reuse the existing webhook dispatcher configuration.

## New API surface

- POST /api/jobs/:id/run/validate
- POST /api/executions/:id/replay
- POST /api/jobs/test-run
- GET /api/platform/activity?window=6h|24h|7d
- GET /api/platform/search?q=...
- GET /api/platform/executor-catalog
- GET and PATCH /api/queues/:name
- POST /api/jobs/:id/backfills/preview
- POST /api/jobs/:id/backfills
- lifecycle, event, and bulk routes under /api/attention
- channel, policy, delivery, and retry routes under /api/notifications

Existing endpoints and executor-name discovery remain available.

## Migrations and rollout

| Migration | Scope |
| --- | --- |
| 010 | Input, replay, and idempotency execution storage |
| 011 | Private activity-query indexes |
| 012 | Persisted draft-test and suppression fields |
| 013 | Queue policies, rate windows, concurrency, and backfill uniqueness |
| 014 | Incident lifecycle, timeline, and notification outbox |
| 015 | Compatibility defaults for legacy direct Attention writers |

Before rollout:

1. Back up PostgreSQL.
2. Run npm run migrate.
3. Run the build, unit, integration, and dashboard checks listed below.
4. Confirm /health/ready, worker subscriptions, queue policies, and the connection badge.
5. Exercise one non-production test execution and notification delivery.

The migrations do not delete job, execution, audit, or Attention history. There are intentionally no automatic down migrations. Prefer a forward compatibility fix while leaving the additive schema in place. A full rollback to a pre-010 binary requires restoring the pre-upgrade database backup because older binaries reject a newer schema version. Do not manually drop new columns or tables from a live database. Restoring a backup discards post-backup writes and requires an explicit operational decision.

## Verification

    npm run build
    npm run typecheck:test
    npm test
    npm run test:integration
    Set-Location dashboard
    npm test
    npm run build

Manual acceptance should cover keyboard command search, incident arrow-key navigation, the workflow canvas, a 320px viewport, replay confirmations, and notification secret references. The production build may report a bundle-size advisory because the DAG editor is included; this is not a build failure.
