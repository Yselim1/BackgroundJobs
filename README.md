# Background Jobs Framework

A Node.js 24+ and TypeScript background-job service with PostgreSQL-backed definitions, durable execution history and progress events, six-field cron scheduling, a transactional work queue, bounded concurrency, retries, cancellation, job deadlines, runtime input, and reliable terminal webhooks.

[![Workline operations overview](docs/images/dashboard/overview-metrics.png)](docs/images/dashboard/overview.png)

The backend is paired with the independent **Workline** operations dashboard. See the [visual dashboard tour](dashboard/README.md) for illustrated workflows covering job authoring, automations, execution investigation, attention triage, workers, queues, and notification routing.

The Run/Investigation, Operations Shell, Workflow Authoring, Queue/Backfill, and Incident/Notification expansion is documented in [docs/product-expansion.md](docs/product-expansion.md), including API additions, rollout checks, and rollback guidance.

PostgreSQL is the source of truth. No job or execution exists only in process memory, and the reference file in `examples/jobs.json` is never imported at runtime.

## Start locally

Requirements: Node.js 24+, npm, Docker, and Docker Compose.

```bash
npm install
npm run dev
```

`npm run dev` starts Docker Desktop when needed, starts the Compose PostgreSQL service, waits until it is healthy, applies any pending migrations, and then starts the backend watcher. Docker Desktop can remain closed after restarting your computer; the development command will launch it and wait for the engine. To start only the backend watcher when PostgreSQL is managed separately, use `npm run dev:server`.

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

To add safe examples for managed secrets, notifications, and job automations to an initialized local database, run:

```powershell
npm run examples:seed
```

The command is idempotent and creates its notification channel, notification policy, job-completion automation, and inbound webhook trigger disabled. Its example Slack webhook uses the non-routable `example.invalid` domain.

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
| `EMBEDDED_WORKER_ENABLED` | development: `true`; production: `false` | Let the API process also claim and execute jobs |
| `WORKER_WORK_DIRECTORY` | unset | Dedicated root and default `CWD` for a standalone worker |
| `WORKER_REQUIRE_NON_ADMIN` | `false` | Refuse to start a standalone worker as root or a Windows Administrators-group member |
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

Dynamic commands use an executable and argument array so resolved input never becomes shell syntax:

```json
{
  "TYPE": "COMMAND",
  "STEP_PARAMS": {
    "EXECUTABLE": "node",
    "ARGS": ["-e", "console.log(process.argv[1])", "{{input.message}}"],
    "TIMEOUT_MS": 10000
  }
}
```

Legacy `COMMAND` strings remain supported when completely static. They cannot contain context templates. `EXECUTABLE` and `CWD` are also literal; individual `ARGS` may resolve scalar context values. COMMAND and PYTHON receive only a minimal operating-system environment plus explicitly declared `ENV` values. Environment templates must be exact managed-secret references such as `{{secrets.API_TOKEN}}`.

REST URLs must have a literal `http` or `https` origin; templates may appear only after the origin. Redirects are limited to five hops on that same origin. Response bodies default to 5 MiB and can set `MAX_RESPONSE_BYTES` between 1 KiB and 10 MiB. SCRIPT functions are synchronous; Promise-returning functions fail explicitly.

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

### Run jobs in an isolated, non-administrator worker

The hardened worker profile separates job execution from the API process. Production disables the embedded worker by default; for local development, put `EMBEDDED_WORKER_ENABLED=false` in the ignored root `.env` and restart the backend. Then start the isolated worker:

```powershell
npm run worker:isolated
```

The profile applies migrations and runs `dist/worker.js` as the dedicated Linux user and group `10001:10001`. Its image filesystem is read-only, all Linux capabilities are dropped, privilege escalation is disabled, and the `backgroundjobs-worker` volume mounted at `/work` is its only writable persistent location. `WORKER_WORK_DIRECTORY=/work` makes that directory the default COMMAND `CWD` and rejects an authored `CWD` that escapes it. Python temporary scripts also use `/work/tmp`. The worker can still read its runtime and application files and can reach PostgreSQL and authored network destinations; the boundary reduces host-file impact but does not make hostile job code safe.

The profile reads `SECRETS_MASTER_KEY` and other worker settings from the ignored `.env` when present, while overriding the database hostname for Compose. Stop it with `npm run worker:isolated:stop`. Re-enable `EMBEDDED_WORKER_ENABLED=true` before returning to the all-in-one development process.

For a native worker instead of Docker, create a standard OS account yourself, grant that account access only to a dedicated directory, and launch `npm run start:worker` from that account with absolute `WORKER_WORK_DIRECTORY` and `WORKER_REQUIRE_NON_ADMIN=true` values. The startup guard refuses root and Windows Administrators-group members, but the operating-system ACL—not Node.js—must enforce which other files the account can read or write.

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

### Current security limitations

This project is designed for trusted job authors and local or otherwise trusted environments. Authentication and role checks protect job-definition writes, but a permitted author can still define privileged work.

- Static shell commands, Python, synchronous SCRIPT code, and executor plugins retain the worker account's filesystem, process, and network permissions. The isolated worker above limits writable files but is not a hostile-code sandbox.
- A step receives every managed secret referenced anywhere in its job definition. A trusted author can therefore copy one step's referenced secret from `context.secrets`; per-step secret grants are not implemented.
- Managed secrets should be referenced by name. Literal credentials embedded in job definitions, runtime input, or command arguments cannot be reliably identified or redacted from every external process or destination.
- Localhost and private-network HTTP targets remain allowed when their origins are statically authored, so a trusted author can intentionally contact internal services reachable from the worker.
- API tokens inherit the complete role of their owner and do not yet support narrower per-token scopes.
- Application-level request rate limiting is not implemented. Authentication lockouts constrain password guessing, but an internet-facing deployment still needs a trusted reverse proxy or gateway for general abuse controls.
- Hostile-author container or VM isolation and private-network egress blocking remain deferred while the application is local and not internet-facing. Do not allow untrusted users to create or modify definitions, plugins, or worker images.

Use the isolated worker profile or an equivalently restricted native service account, keep managed secrets out of literal job fields, and review definitions before activation. These controls reduce the effect of mistakes; they do not remove the trusted-author assumption.

Production startup fails unless secure cookies and an explicit `CORS_ALLOWED_ORIGINS` list are configured. Terminate TLS at the application or a trusted reverse proxy, set `TRUST_PROXY=true` only for that topology, and keep the dashboard and API on the same origin where possible.

## History retention

Retention is an explicit operator action. It selects terminal executions and inactive worker registrations whose last heartbeat is older than the cutoff. It is a dry run unless --confirm is present; queued and running work and any worker that owns a running execution are never deleted.

~~~bash
npm run retention -- --days 90
npm run retention -- --days 90 --batch-size 500 --confirm
~~~

Associated steps, attempts, progress events, and webhook deliveries are removed in the same database cascade. Historical worker references on retained terminal executions are cleared when an old registration is removed.

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

The Workline dashboard is an independent React/Vite project in `dashboard/`. It has its own dependencies, build, tests, and dev server so frontend development and deployment are not coupled to the backend runtime.

[![Workline job dependency plan](docs/images/dashboard/workflow-plan.png)](docs/images/dashboard/workflow.png)

~~~bash
# Terminal 1: backend
npm run dev

# Terminal 2: dashboard (proxies /api to localhost:3000)
cd dashboard
npm install
npm run dev
~~~

For production, run `npm run build` inside `dashboard/` and serve its `dist/` output behind the same origin/reverse proxy as the API. `VITE_API_BASE_URL` can point at an origin explicitly listed in `CORS_ALLOWED_ORIGINS`.

The dashboard provides login/logout, permission-aware run/cancel controls, a dedicated `/admin` workspace, immutable audit review, a shared `/attention` triage queue, and `/workers` fleet visibility. Job details include URL-addressable Overview, Versions, and Automations tabs with revision diffs, safe rollback, one-time webhook credentials, chain configuration, and durable trigger history. Its Jobs workspace retains filters, sorting, bulk status changes, definition duplication/export, schedule previews, queue/priority controls, secret suggestions, and dependency previews. The [dashboard README](dashboard/README.md) explains each workspace with current screenshots and an operator-focused route map.
