# Examples

`jobs.json` contains the original proof-of-concept job definitions. The application never reads it at runtime; PostgreSQL remains authoritative.

Validate the legacy definitions without writing anything:

```bash
npm run jobs:import -- examples/jobs.json --dry-run
```

Import them as inactive jobs after reviewing the normalized output:

```bash
npm run jobs:import -- examples/jobs.json --apply
```

To populate an initialized local database with safe operational examples, run:

```bash
npm run examples:seed
```

The seed command is idempotent. It adds a non-routable managed secret, a disabled Slack notification channel, a disabled high-severity notification policy, a disabled job-completion automation, and a disabled inbound webhook trigger. It does not send notifications or launch jobs.

Some legacy definitions demonstrate static `COMMAND` compatibility. New dynamic command steps should use `EXECUTABLE` with an `ARGS` array; runtime values in `ARGS` are passed directly to the process and never interpreted as shell syntax.
