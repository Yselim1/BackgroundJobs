# Background Jobs Framework

A Node.js 24+ and TypeScript background-job service with PostgreSQL-backed definitions, durable execution history and progress events, six-field cron scheduling, a transactional work queue, bounded concurrency, retries, cancellation, job deadlines, runtime input, and reliable terminal webhooks.

PostgreSQL is the source of truth. No job or execution exists only in process memory, and the reference file in `examples/jobs.json` is never imported at runtime.

## Start locally

Requirements: Node.js 24+, npm, Docker, and Docker Compose.

```bash
npm install
docker compose up -d postgres
npm run migrate
npm run dev
```

The default connection is `postgres://postgres:postgres@localhost:5432/backgroundjobs`; copy `.env.example` into your environment when different values are needed. Environment variables are not automatically loaded from a file.

Configuration:

| Variable | Default | Purpose |
| --- | ---: | --- |
| `DATABASE_URL` | local Compose URL | PostgreSQL connection string |
| `DB_POOL_MAX` | `10` | Maximum pooled database connections |
| `WORKER_CONCURRENCY` | `4` | Maximum concurrently running jobs |
| `SCHEDULER_POLL_MS` | `1000` | Scheduler and dispatcher poll interval |
| `SHUTDOWN_GRACE_MS` | `10000` | Grace before running work is interrupted |
| `PORT` | `3000` | HTTP port |

Application startup checks the migration version and exits with an actionable error if the database is behind. Migrations are numbered SQL files and `npm run migrate` serializes concurrent migrators with a PostgreSQL advisory lock.

## Job definition

```json
{
  "id": "daily-report",
  "name": "Daily report",
  "status": "active",
  "schedule": "0 0 8 * * *",
  "timezone": "Europe/Istanbul",
  "TIMEOUT_MS": 300000,
  "MAX_CONCURRENCY": 2,
  "FAILURE_POLICY": "fail_fast",
  "DEFAULT_STEP_RETRY": {
    "MAX_ATTEMPTS": 3,
    "DELAY_MS": 1000,
    "BACKOFF": "exponential"
  },
  "STEPS": [
    {
      "ORDER": 1,
      "ID": "fetch",
      "NAME": "Fetch data",
      "TYPE": "RESTAPI",
      "STEP_PARAMS": {
        "URL": "https://example.internal/data",
        "METHOD": "GET",
        "TIMEOUT_MS": 10000
      }
    },
    {
      "ORDER": 2,
      "ID": "transform",
      "NAME": "Transform",
      "TYPE": "SCRIPT",
      "DEPENDS_ON": ["fetch"],
      "STEP_PARAMS": {
        "CODE": "(context) => ({ count: context.fetch.data.length })"
      }
    }
  ]
}
```

Schedules must contain exactly six fields, including seconds. `timezone` is an IANA identifier and defaults to `UTC`. Inactive jobs are not scheduled but can be run manually. `last_run` and `next_run` are server-managed response fields and are rejected in create/replace bodies.

Supported step types are `RESTAPI`, `SCRIPT`, `COMMAND`, and `PYTHON`. Step dependencies, retry settings, job step concurrency, `fail_fast`, and `continue_independent` are preserved. Persisted outputs must be JSON-serializable; top-level `undefined` is stored as SQL null, while circular values, `BigInt`, functions, symbols, and non-finite numbers fail with `OUTPUT_NOT_SERIALIZABLE`.

## HTTP API

| Method | Route | Description |
| --- | --- | --- |
| `GET` | `/health` | Process liveness |
| `GET` | `/health/ready` | Database, schema, scheduler, and dispatcher readiness |
| `GET` | `/api/jobs` | List jobs |
| `POST` | `/api/jobs/validate` | Validate a definition |
| `POST` | `/api/jobs` | Create a job |
| `GET` | `/api/jobs/:id` | Get a job |
| `PUT` | `/api/jobs/:id` | Replace a job |
| `DELETE` | `/api/jobs/:id` | Delete a job while preserving history |
| `GET` | `/api/jobs/:id/plan` | Inspect dependency levels |
| `POST` | `/api/jobs/:id/run` | Queue a manual execution (`202`) |
| `GET` | `/api/executions` | Filter and cursor-page execution summaries |
| `GET` | `/api/executions/:id` | Get an execution with steps and attempts |
| `GET` | `/api/executions/:id/events` | Replay and follow durable progress using SSE |
| `GET` | `/api/executions/:id/webhooks` | Inspect webhook delivery state |
| `POST` | `/api/executions/:id/cancel` | Cancel queued or running work |
| `GET` | `/api/logs` | Legacy array alias |
| `GET` | `/api/logs/:id` | Legacy detail alias |

Execution list parameters are `jobId`, `status`, `trigger`, `from`, `to`, `limit` (default 50, maximum 200), and opaque `cursor`. Ordering is `requestedAt DESC, executionId DESC`.

A manual run returns immediately:

```json
{
  "executionId": "d4f84ca4-d41f-4aac-944a-d21e45c50ac6",
  "logId": "d4f84ca4-d41f-4aac-944a-d21e45c50ac6",
  "jobId": "daily-report",
  "trigger": "manual",
  "status": "queued",
  "requestedAt": "2026-07-31T12:00:00.000Z"
}
```

The response has `Location: /api/executions/:executionId`. Replacing or deleting a job with queued/running work returns `409 JOB_IS_ACTIVE`. Cancelling a cancelled execution is idempotent; cancelling another terminal status returns `409 EXECUTION_NOT_CANCELLABLE`.

## Scheduling and recovery

The scheduler locks due jobs transactionally. After downtime it records only the latest missed occurrence and advances directly to the next future time. If the job already has queued/running work, that occurrence is stored as terminal `skipped` with reason `overlap`. Scheduled occurrence and active-job uniqueness are database-enforced.

Workers claim the oldest execution with `FOR UPDATE SKIP LOCKED`. On startup, orphaned `running` executions become `failed` with `SERVER_INTERRUPTED`; queued work remains eligible. Graceful shutdown stops scheduling/claiming, waits for the configured grace, and then aborts remaining executors. REST request signals are combined with request timeouts, and command/Python cancellation terminates spawned process trees.

## Tests and build

```bash
npm test
npm run test:integration
npm run build
```

Unit tests cover cron/DST calculations, coalescing, abortable retries, job deadlines, output serialization, runtime input, webhook validation, and signatures. Integration tests use Testcontainers PostgreSQL for migrations, repositories, queue lifecycle, restart reconciliation, API contracts, pagination/search, SSE replay, webhook retry/recovery, cancellation, and retention; Docker must be running.

## Runtime input and progress events

Manual runs accept an optional JSON object:

~~~http
POST /api/jobs/daily-report/run
Content-Type: application/json

{
  "input": {
    "reportDate": "2026-07-31",
    "accountId": 42
  }
}
~~~

Input is stored with the execution. Scripts read it from context.input, while REST request templates can use paths such as {{input.accountId}} without adding a step dependency. Input must be a JSON object and must be fully JSON-serializable. The step ID input is reserved for this context root.

GET /api/executions/:id/events is a replayable Server-Sent Events stream. Clients can reconnect with the Last-Event-ID header or the after query parameter. Events are persisted before execution continues and include execution, step, and attempt transitions. The stream closes after the terminal event has been replayed.

GET /api/executions supports trigger, from, and to in addition to the existing filters. from is inclusive, to is exclusive, and both are ISO-8601 timestamps.

## Reliable webhooks

Jobs can define up to ten terminal webhooks:

~~~json
{
  "WEBHOOKS": [
    {
      "URL": "https://example.internal/job-events",
      "EVENTS": ["success", "failed", "cancelled"]
    }
  ]
}
~~~

Omitting EVENTS subscribes to success, failed, cancelled, and skipped. Terminal state and webhook delivery are committed in one PostgreSQL transaction. The dispatcher retries failures with persisted exponential backoff, recovers interrupted deliveries after restart, and exposes state at GET /api/executions/:id/webhooks.

Webhook configuration:

| Variable | Default | Purpose |
| --- | ---: | --- |
| WEBHOOK_CONCURRENCY | 2 | Maximum concurrent webhook requests |
| WEBHOOK_POLL_MS | 500 | Outbox poll interval |
| WEBHOOK_MAX_ATTEMPTS | 5 | Maximum attempts per delivery |
| WEBHOOK_REQUEST_TIMEOUT_MS | 10000 | Timeout for each request |
| WEBHOOK_SIGNING_KEY | unset | Optional global HMAC-SHA256 key |

Each request includes X-Backgroundjobs-Delivery, X-Backgroundjobs-Event, and X-Backgroundjobs-Timestamp. When WEBHOOK_SIGNING_KEY is configured, X-Backgroundjobs-Signature contains an HMAC-SHA256 signature over the timestamp and exact body. Per-job credentials and secret storage remain deferred to the security/authentication milestone.

## History retention

Retention is an explicit operator action and only selects terminal executions. It is a dry run unless --confirm is present; queued and running work is never deleted.

~~~bash
npm run retention -- --days 90
npm run retention -- --days 90 --batch-size 500 --confirm
~~~

Associated steps, attempts, progress events, and webhook deliveries are removed in the same database cascade.

## Adding Kafka or RabbitMQ later

Keep PostgreSQL authoritative and publish from the transactional event/outbox records introduced in this milestone. RabbitMQ can wake work-queue consumers; Kafka can carry lifecycle events for audit, analytics, notifications, and downstream systems. A consumer should receive only an execution ID, claim/verify it in PostgreSQL, and be idempotent under at-least-once delivery. Cancellation messages are hints—the persisted `cancel_requested_at` value remains decisive.
