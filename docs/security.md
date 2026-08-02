# Security model

Background Jobs Framework is intended for local or otherwise trusted environments where job authors and administrators are trusted. Authentication and role checks protect definition writes, but authored jobs remain privileged code.

## Existing protections

- Passwords use Argon2id; browser sessions are opaque, hashed in PostgreSQL, `HttpOnly`, and protected by CSRF checks.
- Role checks separate read access, execution controls, and administration.
- Managed secrets use AES-256-GCM and their values are write-only in the dashboard.
- Command and Python child processes inherit only a small operating-system environment allowlist.
- Dynamic commands use a literal executable and separately resolved arguments with `shell: false`.
- REST, webhook, and notification redirects remain on the authored origin and response sizes are bounded.
- Job revisions, audit events, execution progress, incidents, and outbound deliveries are durable.

## Remaining limitations

- Static shell commands, Python, synchronous Script code, and executor plugins retain the worker account's filesystem, process, and network permissions.
- Every step receives the managed secrets referenced anywhere in its job definition; per-step secret grants are not implemented.
- Literal credentials in definitions, runtime input, or process arguments cannot be reliably detected or redacted everywhere.
- Statically authored localhost and private-network HTTP destinations remain permitted.
- API tokens inherit the complete role of their owner and do not have narrower per-token scopes.
- General application-level rate limiting and private-network egress blocking are not implemented.
- The isolated worker reduces host-file impact but is not a hostile-code sandbox. Container or VM isolation for untrusted authors is intentionally out of scope.

## Isolated worker

Production disables embedded job execution by default. For local development, add this to the ignored `.env` and restart the backend:

```env
EMBEDDED_WORKER_ENABLED=false
```

Start the worker profile:

```powershell
npm run worker:isolated
```

The worker runs as Linux UID/GID `10001:10001`, drops all capabilities, disables privilege escalation, uses a read-only image filesystem, and mounts `/work` as its only writable persistent directory. `WORKER_WORK_DIRECTORY=/work` also prevents a Command step's configured `CWD` from escaping that directory.

For a native worker, create a standard OS account, grant it access only to a dedicated directory, and start the worker with:

```env
WORKER_WORK_DIRECTORY=/absolute/worker/path
WORKER_REQUIRE_NON_ADMIN=true
```

The startup guard rejects root and Windows Administrators-group members. Operating-system ACLs must enforce access to other files.

## Deployment notes

- Do not allow untrusted users to create definitions, plugins, or worker images.
- Never commit `.env`; retain a secure backup of `SECRETS_MASTER_KEY` because encrypted values cannot be recovered after losing it.
- Use HTTPS, secure cookies, and an explicit `CORS_ALLOWED_ORIGINS` list outside local development.
- Put an internet-facing deployment behind a trusted gateway that provides general rate limiting and request controls.
- Keep the dashboard and API on the same origin when possible.
