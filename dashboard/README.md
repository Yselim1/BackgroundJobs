# Workline Dashboard

Independent React/Vite operations UI for Background Jobs Framework.

## Development

Start the backend on port 3000, then:

~~~bash
npm install
npm run dev
~~~

Vite proxies `/api` and `/health` to the backend, avoiding a development CORS dependency.

## Build and test

~~~bash
npm test
npm run build
~~~

The production bundle is written to `dashboard/dist`. Keep it on the same origin as the API where possible. Cross-origin deployments must set `VITE_API_BASE_URL` and include that exact origin in the backend `CORS_ALLOWED_ORIGINS` list.

Set `VITE_API_BASE_URL` at build time only when the API is intentionally hosted on another origin.

The dashboard never stores session or API tokens in browser storage. Login uses the backend's `HttpOnly` session cookie, mutating requests attach the CSRF cookie value as `X-CSRF-Token`, and live execution streams send the same credentials. Temporary passwords open only the mandatory password-change screen. Every role can inspect job revisions, automations, workers, and queues; administrators manage definitions, triggers, webhook token rotation, worker drain state, security, and operational remediation.

## Operations workspace

- `/jobs` provides URL-persisted search, status, scheduling, executor, timezone, and sort controls.
- `/jobs/:jobId` shows the definition settings, dependency levels, and recent executions.
- `/jobs/:jobId?tab=versions|automations` shows immutable revision diffs/rollback or event-trigger configuration/history.
- `/workers` shows queue backlog, fleet capacity, leases, and administrator drain/resume controls.
- `/logs` filters durable history by job, status, trigger, time range, and oldest/newest ordering.
- `/logs/:executionId` deep-links to actor, input, cancellation, step/attempt, output, snapshot, and webhook details.
- `/attention` provides URL-persisted Open, Ignored, and Resolved views with kind, search, inclusive day range, and exact server pagination.
- `/admin?tab=users|secrets|system` provides user/credential administration, a role matrix, write-only secret lifecycle and dependency inspection, and safe read-only runtime health.
- `/audit` provides immutable, filterable audit history for administrators.

The editor calculates upcoming schedule occurrences on the server, warns before activating sub-minute schedules, discovers registered executor types, previews dependency levels, and autocompletes managed-secret names without fetching their values. Execution tables refresh through an authenticated global SSE feed. The overview includes worker utilization, queue latency, oldest queued age, and 24-hour success rate.

The dashboard uses clean History API routes. Production hosting must serve `index.html` for unknown frontend paths such as `/jobs`, `/logs/:executionId`, `/attention`, and `/admin`, while continuing to proxy `/api` and `/health` to the backend.
