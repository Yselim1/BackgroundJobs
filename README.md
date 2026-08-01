# Background Jobs Framework

A Node.js 24+ and TypeScript background-job service with PostgreSQL-backed definitions, durable execution history and progress events, six-field cron scheduling, a transactional work queue, bounded concurrency, retries, cancellation, job deadlines, runtime input, and reliable terminal webhooks.

PostgreSQL is the source of truth. No job or execution exists only in process memory, and the reference file in `examples/jobs.json` is never imported at runtime.

## Start locally

Requirements: Node.js 24+, npm, Docker, and Docker Compose.

```bash
npm install
npm run dev
```

`npm run dev` starts the Compose PostgreSQL service, waits until it is healthy, applies any pending migrations, and then starts the backend watcher. Docker must already be running. To start only the backend watcher when PostgreSQL is managed separately, use `npm run dev:server`.

There are no default credentials. On the first installation, prepare the database and create exactly one initial administrator:

```powershell
npm run dev:setup
$env:BOOTSTRAP_ADMIN_EMAIL='admin@example.com'
$env:BOOTSTRAP_ADMIN_NAME='Administrator'
$env:BOOTSTRAP_ADMIN_PASSWORD='replace-with-a-long-unique-password'
npm run auth:bootstrap
npm run dev:server
```

Bootstrap refuses to run after the first user exists. Subsequent local starts need only `npm run dev`.

The default connection is `postgres://postgres:postgres@localhost:5432/backgroundjobs`; copy `.env.example` to `.env` when different values are needed. Development scripts load the ignored root `.env` automatically.

Configuration:

| Variable | Default | Purpose |
| --- | ---: | --- |
| `DATABASE_URL` | local Compose URL | PostgreSQL connection string |
| `DB_POOL_MAX` | `10` | Maximum pooled database connections |
| `WORKER_CONCURRENCY` | `4` | Maximum concurrently running jobs |
| `WORKER_NAME` | hostname and process ID | Worker name shown in the dashboard |
| `WORKER_QUEUES` | `default` | Comma-separated queues this worker consumes |
| `WORKER_HEARTBEAT_MS` | `5000` | Worker heartbeat and cancellation-check interval |
| `EXECUTION_LEASE_MS` | `20000` | Duration of a renewable execution ownership lease |
| `WORKER_STALE_MS` | `30000` | Time after which a missing worker is shown offline |
| `SCHEDULER_POLL_MS` | `1000` | Scheduler and dispatcher poll interval |
| `SHUTDOWN_GRACE_MS` | `10000` | Grace before running work is interrupted |
| `AUTH_SESSION_TTL_MS` | `43200000` | Absolute server-side session lifetime |
| `AUTH_SESSION_IDLE_MS` | `1800000` | Sliding idle-session lifetime |
| `AUTH_COOKIE_SECURE` | production: `true` | Restrict session and CSRF cookies to HTTPS |
| `CORS_ALLOWED_ORIGINS` | local API and Vite origins | Exact browser origins allowed to call the API |
| `TRUST_PROXY` | `false` | Trust one reverse proxy hop for client addressing |
| `SECRETS_MASTER_KEY` | unset | Base64-encoded 32-byte AES-256 managed-secret key |
| `PORT` | `3000` | HTTP port |

Application startup checks the migration version and exits with an actionable error if the database is behind. Migrations are numbered SQL files and `npm run migrate` serializes concurrent migrators with a PostgreSQL advisory lock.

### Import legacy JSON jobs

Legacy job arrays can be validated and normalized before they are moved into PostgreSQL:

```powershell
npm run jobs:import -- examples/jobs.json --dry-run
npm run jobs:import -- examples/jobs.json --apply
```

The importer converts five-field cron schedules to six fields, defaults missing timezones to UTC, removes server-managed timestamp fields, converts `maxRetries` to `DEFAULT_STEP_RETRY.MAX_ATTEMPTS`, and refuses duplicate IDs. Imports are transactional and every imported job is forced to `inactive` so high-frequency or intentionally failing jobs cannot begin running before review. Run the dry-run first; `--apply` is the only mode that writes to PostgreSQL.

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
| `POST` | `/api/jobs/schedule-preview` | Validate a schedule and calculate its next 1–10 occurrences |
| `POST` | `/api/jobs/bulk-status` | Atomically activate or deactivate up to 100 jobs |
| `POST` | `/api/jobs` | Create a job |
| `GET` | `/api/jobs/:id` | Get a job |
| `PUT` | `/api/jobs/:id` | Replace a job |
| `DELETE` | `/api/jobs/:id` | Delete a job while preserving history |
| `GET` | `/api/jobs/:id/plan` | Inspect dependency levels |
| `GET` | `/api/jobs/:id/versions` | Page immutable job revisions |
| `GET` | `/api/jobs/:id/versions/:version` | Inspect one revision |
| `POST` | `/api/jobs/:id/rollback` | Create a new revision from an older definition |
| `POST` | `/api/jobs/:id/run` | Queue a manual execution (`202`) |
| `GET` | `/api/workers` | Inspect registered workers and lease health |
| `GET` | `/api/queues` | Inspect per-queue backlog and capacity |
| `POST` | `/api/workers/:id/drain` | Stop a worker from claiming new work |
| `POST` | `/api/workers/:id/resume` | Resume a drained worker |
| `GET` | `/api/executions` | Filter and cursor-page execution summaries |
| `GET` | `/api/executions/events` | Follow new durable execution/step events using SSE |
| `GET` | `/api/executions/:id` | Get an execution with steps and attempts |
| `GET` | `/api/executions/:id/events` | Replay and follow durable progress using SSE |
| `GET` | `/api/executions/:id/webhooks` | Inspect webhook delivery state |
| `POST` | `/api/executions/:id/cancel` | Cancel queued or running work |
| `GET` | `/api/logs` | Legacy array alias |
| `GET` | `/api/logs/:id` | Legacy detail alias |

Execution list parameters are `jobId`, `status`, `trigger`, `from`, `to`, `order` (`desc` by default or `asc`), `limit` (default 50, maximum 200), and opaque `cursor`. Ordering uses `requestedAt` and `executionId` in the selected direction.

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

The response has `Location: /api/executions/:executionId`. Replacing a job is safe while older snapshots are queued or running; deleting a job with queued/running work returns `409 JOB_IS_ACTIVE`. Cancelling a cancelled execution is idempotent; cancelling another terminal status returns `409 EXECUTION_NOT_CANCELLABLE`.

## Scheduling and recovery

The scheduler locks due jobs transactionally. After downtime it records only the latest missed occurrence and advances directly to the next future time. If the job already has queued/running work, that occurrence is stored as terminal `skipped` with reason `overlap`. Scheduled occurrence and active-job uniqueness are database-enforced.

Workers claim compatible executions with `FOR UPDATE SKIP LOCKED`. Running executions carry renewable worker leases; expired ownership becomes `failed/WORKER_LOST`, while graceful shutdown failures use `SERVER_INTERRUPTED` and queued work remains eligible. Shutdown stops scheduling/claiming, waits for the configured grace, and then aborts remaining executors. REST request signals are combined with request timeouts, and command/Python cancellation terminates spawned process trees.

## Job revisions and worker queues

Every create, edit, status change, import, and rollback creates an immutable sequential job revision. `PUT /api/jobs/:id` requires the current version in `If-Match`; a stale editor receives `409 JOB_VERSION_CONFLICT`. Rollback creates another revision and preserves the job's current active/inactive state. Every new execution records both the exact definition snapshot and its revision number.

Manual and event-triggered requests may backlog while a job is running; only one execution per job runs at once. Scheduled overlap still produces a skipped occurrence. `QUEUE` defaults to `default`, `PRIORITY` defaults to zero, and workers claim higher priority first while preserving FIFO order within a priority.

`npm run dev` retains the all-in-one API, scheduler, dispatcher, and worker. Run `npm run dev:worker` in another terminal to add a PostgreSQL-coordinated worker. Worker heartbeats renew execution leases and observe remote cancellation; an expired lease fails once with `WORKER_LOST` rather than automatically repeating potentially non-idempotent side effects.

## Inbound events and job chaining

Administrators configure webhook and job-completion triggers from a job's Automations tab. Webhook creation or rotation returns a `bj_hook_...` bearer token exactly once; only its SHA-256 hash is stored. Invoke it with `POST /hooks/:triggerId`, a JSON-object body, and `Authorization: Bearer ...`. An optional `Idempotency-Key` returns the original queued execution for repeated delivery.

Job-completion triggers select a source job and terminal states. Terminal transactions write a durable outbox event, and the automation dispatcher queues the target with source metadata, original input, and persisted step outputs. Cycles are rejected. Automatic triggers pause while the target job is inactive; manual runs remain allowed.

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
      "EVENTS": ["success", "failed", "cancelled"],
      "SIGNING_SECRET": "WEBHOOK_SIGNING_KEY"
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
| WEBHOOK_SIGNING_KEY | unset | Legacy optional global HMAC-SHA256 key |

Each request includes X-Backgroundjobs-Delivery, X-Backgroundjobs-Event, and X-Backgroundjobs-Timestamp. When `SIGNING_SECRET` names a managed secret, X-Backgroundjobs-Signature contains an HMAC-SHA256 signature over the timestamp and exact body. The legacy global `WEBHOOK_SIGNING_KEY` is used only when a webhook does not select a managed signing secret.

## Security and authentication

Every `/api` endpoint is authenticated except `POST /api/auth/login`. Liveness and readiness remain public. Browser sessions use random opaque identifiers stored only as SHA-256 hashes in PostgreSQL; the session cookie is `HttpOnly` and `SameSite=Strict`, while every cookie-authenticated mutation must also present the matching CSRF header. Automation can use revocable `bj_pat_...` bearer tokens, whose raw values are returned only once and are never stored.

Roles are intentionally narrow:

| Role | Access |
| --- | --- |
| `viewer` | Read jobs, revisions, automations, execution history, workers, platform status, and operational attention |
| `operator` | Viewer access plus queueing jobs and cancelling executions |
| `admin` | Operator access plus job definitions, attention remediation, users, roles, managed secrets, and audit history |

Job-definition writes remain admin-only because command, Python, script, and plugin executors are privileged code-execution capabilities. Passwords use native Argon2id, repeated failures produce a temporary account lock, administrator-created/reset passwords must be replaced before application access, resets revoke sessions and API tokens, disabled users lose active access, and the final active administrator cannot be disabled or demoted.

Security endpoints:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/auth/me` | Current identity, role, and permissions |
| `POST` | `/api/auth/logout` | Revoke the current browser session |
| `POST` | `/api/auth/password` | Change password and revoke existing access |
| `GET/POST/DELETE` | `/api/auth/tokens` | Manage the current user's API tokens |
| `GET/POST/PATCH` | `/api/security/users` | Administer users, roles, and status |
| `GET` | `/api/security/roles` | Read the authoritative role/permission matrix |
| `GET` | `/api/security/users/:id/access` | Inspect a user's session and API-token metadata |
| `POST` | `/api/security/users/:id/revoke-access` | Revoke all sessions and active API tokens for a user |
| `DELETE` | `/api/security/users/:id/sessions/:sessionId` | Revoke one browser session |
| `DELETE` | `/api/security/users/:id/tokens/:tokenId` | Revoke one API token |
| `POST` | `/api/security/users/:id/unlock` | Clear an automatic failed-login lockout |
| `GET/PUT/DELETE` | `/api/security/secrets` | List metadata, store/rotate, or dependency-safe delete secrets |
| `GET` | `/api/security/secrets/:name/usage` | Inspect current job and webhook-signing references |
| `GET` | `/api/security/system` | Read safe runtime, database, service, and retention status |
| `GET` | `/api/security/audit` | Filter cursor-paginated immutable audit history |

Operational attention endpoints:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/attention` | Exact page-mode listing by state, kind, search, and inclusive day range |
| `GET` | `/api/attention/:id` | Inspect a durable execution or webhook failure snapshot |
| `POST` | `/api/attention/:id/ignore` | Hide an open item from shared active counts |
| `POST` | `/api/attention/:id/restore` | Restore an ignored item to Open |
| `POST` | `/api/attention/:id/rerun` | Queue the current job definition with the failed execution's original input |
| `POST` | `/api/attention/:id/retry-webhook` | Requeue the exact webhook delivery for an immediate attempt |

Every role can inspect attention. Mutations are administrator-only, global, and audited. Execution and terminal webhook failures create or reopen stable records transactionally; ignored and resolved records remain inspectable until their source execution is removed by retention.

The audit table records request IDs, actor identity, action, result, resource, client address, and user agent. A PostgreSQL trigger rejects updates and deletes. Passwords, request bodies, API-token values, and managed-secret values are never written to audit metadata.

Managed secrets are encrypted with AES-256-GCM. Generate a master key outside the repository:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
$env:SECRETS_MASTER_KEY='paste-the-generated-value'
```

For local development, store the same value in the ignored root `.env` as `SECRETS_MASTER_KEY=...`; `npm run dev` loads that file automatically. Never commit `.env`, and retain a secure backup because existing encrypted values cannot be recovered with a replacement key.

Secret values remain write-only. Metadata includes an assignable owner, latest rotation actor, and optional advisory expiry. New and rotated secrets default to 90 days, due-soon warnings begin 14 days before expiry, and expiry never blocks runtime resolution. Deleting a referenced secret requires an explicit force confirmation after the server rechecks current job definitions.

Job definitions reference names rather than values:

```json
{
  "TYPE": "RESTAPI",
  "STEP_PARAMS": {
    "URL": "https://example.internal/report",
    "HEADERS": {
      "Authorization": "Bearer {{secrets.REPORT_API_TOKEN}}"
    }
  }
}
```

Only referenced secrets are decrypted for an execution. Resolved values are redacted from persisted outputs, errors, and REST URL logs. Command and Python steps should consume secrets through `ENV` templates rather than command-line arguments.

Production startup fails unless secure cookies and an explicit `CORS_ALLOWED_ORIGINS` list are configured. Terminate TLS at the application or a trusted reverse proxy, set `TRUST_PROXY=true` only for that topology, and keep the dashboard and API on the same origin where possible.

## History retention

Retention is an explicit operator action and only selects terminal executions. It is a dry run unless --confirm is present; queued and running work is never deleted.

~~~bash
npm run retention -- --days 90
npm run retention -- --days 90 --batch-size 500 --confirm
~~~

Associated steps, attempts, progress events, and webhook deliveries are removed in the same database cascade.

## Conditional and fan-out workflows

Any ordinary step can be guarded with `WHEN` or expanded with `FOREACH`; built-in and plugin executors receive the same workflow behavior.

~~~json
{
  "MAX_CONCURRENCY": 4,
  "STEPS": [
    {
      "ORDER": 1,
      "ID": "notify",
      "NAME": "Notify accounts",
      "TYPE": "RESTAPI",
      "WHEN": {
        "PATH": "input.notificationsEnabled",
        "OPERATOR": "equals",
        "VALUE": true
      },
      "FOREACH": {
        "ITEMS": "input.accounts",
        "MAX_CONCURRENCY": 3
      },
      "STEP_PARAMS": {
        "URL": "https://example.internal/accounts/{{item.id}}/notify",
        "METHOD": "POST",
        "BODY": {
          "position": "{{index}}"
        }
      }
    }
  ]
}
~~~

Workflow paths are safe dot-separated paths rooted at `input` or at a step listed directly in `DEPENDS_ON`. Supported condition operators are `equals`, `not_equals`, `exists`, `not_exists`, `truthy`, `falsy`, numeric/string comparisons, and `contains`.

A false condition records the step as `skipped`, stores `null` in its workflow context, and satisfies downstream dependencies. Fan-out sources must resolve to arrays. Each item receives `item` and zero-based `index` context roots; outputs retain source order, retries are persisted with their item index, and all executor calls share the job-level `MAX_CONCURRENCY` ceiling.

## Executor plugin SDK

Applications can register executor types before starting workers:

~~~ts
import {
  defineExecutorPlugin,
  registerExecutorPlugin
} from "backgroundjobs-framework/sdk";

registerExecutorPlugin(defineExecutorPlugin({
  type: "EMAIL",
  validate: (params, path) =>
    typeof params.TO === "string"
      ? []
      : [{ path: path + ".TO", code: "TO_REQUIRED", message: "TO must be a string." }],
  executor: {
    async execute(step, context, { signal }) {
      // Respect signal and return a JSON-serializable value.
      return { delivered: true };
    }
  }
}));
~~~

Plugin types are normalized to uppercase and cannot replace an existing registration. Plugin validators participate in normal job validation. Every process that may execute a plugin-backed job must register the same plugin during startup.

## Independent dashboard

The operational dashboard is an independent React/Vite project in `dashboard/`. It has its own dependencies, build, tests, and dev server so frontend development and deployment are not coupled to the backend runtime.

~~~bash
# Terminal 1: backend
npm run dev

# Terminal 2: dashboard (proxies /api to localhost:3000)
cd dashboard
npm install
npm run dev
~~~

For production, run `npm run build` inside `dashboard/` and serve its `dist/` output behind the same origin/reverse proxy as the API. `VITE_API_BASE_URL` can point at an origin explicitly listed in `CORS_ALLOWED_ORIGINS`.

The dashboard provides login/logout, permission-aware run/cancel controls, a dedicated `/admin` workspace, immutable audit review, a shared `/attention` triage queue, and `/workers` fleet visibility. Job details include URL-addressable Overview, Versions, and Automations tabs with revision diffs, safe rollback, one-time webhook credentials, chain configuration, and durable trigger history. Its Jobs workspace retains filters, sorting, bulk status changes, definition duplication/export, schedule previews, queue/priority controls, secret suggestions, and dependency previews.

## Adding Kafka or RabbitMQ later

Keep PostgreSQL authoritative and publish from the transactional event/outbox records introduced in this milestone. RabbitMQ can wake work-queue consumers; Kafka can carry lifecycle events for audit, analytics, notifications, and downstream systems. A consumer should receive only an execution ID, claim/verify it in PostgreSQL, and be idempotent under at-least-once delivery. Cancellation messages are hints—the persisted `cancel_requested_at` value remains decisive.
