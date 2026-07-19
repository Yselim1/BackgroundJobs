# Background Jobs Framework

## Overview

This project is a Node.js and TypeScript based background job framework.

It allows you to define jobs in `jobs.json`, execute them through an API, handle step dependencies, retry failed steps, and store execution logs in `logs.json`.

## Requirements

- Node.js 24 or newer
- npm

Visit: https://nodejs.org/en/download/ to download Node.js

Check if the installations are successfull:

```bash
node -v
npm -v
```

This project uses TypeScript and ES Modules.

## Install Dependencies

From project root, run:

```bash
npm install
```

## Run in Development Mode

```bash
npm run dev
```

This starts the server with file watching enabled.

Default server URL:

```txt
http://localhost:3000
```

## Build the Project

```bash
npm run build
```

This compiles the TypeScript files into the `dist/` folder.

## Run the Built Project

```bash
npm start
```

## Job Definitions

Jobs are stored in:

```txt
jobs.json
```

Each job can contain multiple steps.

Example step fields:

```json
{
  "ORDER": 1,
  "ID": "550e8400-e29b-41d4-a716-446655440001",
  "NAME": "Fetch cat fact",
  "TYPE": "RESTAPI",
  "STEP_PARAMS": {
    "URL": "https://catfact.ninja/fact",
    "METHOD": "GET"
  }
}
```

### Scheduling

`schedule`, `last_run`, and `next_run` in job definitions are currently stored as job metadata.

The framework does not automatically schedule jobs yet. Jobs are started through:

```txt
POST /api/jobs/:id/run
```

### Step Dependencies

Use `DEPENDS_ON` to make a step wait for another step.
Successful step outputs are stored in the job context using the step ID.
```json
{
  "ORDER": 2,
  "ID": "parse-cat-fact",
  "NAME": "Parse cat fact",
  "TYPE": "SCRIPT",
  "DEPENDS_ON": ["fetch-cat-fact"],
  "STEP_PARAMS": {
    "CODE": "((context) => { const response = context['fetch-cat-fact']; return response.data; })"
  }
}
```
Steps without dependencies can run independently.
A step is skipped if one of its dependencies fails, is skipped, or is cancelled.

### Context Templates

REST API steps can use outputs from declared dependency steps:

```json
{
  "DEPENDS_ON": ["load-post"],
  "STEP_PARAMS": {
    "URL": "https://example.com/posts",
    "METHOD": "POST",
    "BODY": {
      "title": "Copy: {{load-post.data.title}}",
      "userId": "{{load-post.data.userId}}"
    }
  }
}
```

An exact template preserves the original value type. Templates inside larger strings produce strings.

The referenced step must be listed in DEPENDS_ON. Step IDs used in templates should not contain dots.

## Execution Settings

Jobs support the following execution settings:
```json
{
  "MAX_CONCURRENCY": 2,
  "FAILURE_POLICY": "continue_independent / fail_fast",
  "DEFAULT_STEP_RETRY": {
    "MAX_ATTEMPTS": 3,
    "DELAY_MS": 1000,
    "BACKOFF": "fixed"
  }
}
```

- *`MAX_CONCURRENCY:`* controls how many runnable steps can execute at the same time. The default is 10.
- *`FAILURE_POLICY:`* can be fail_fast or continue_independent. The default is fail_fast.
- *`fail_fast:`* cancels pending steps after a failure. Steps already running are allowed to finish.
- *`continue_independent:`* allows independent steps to continue. Steps that depend on a failed step are skipped.
- *`FAIL_JOB_ON_FAILURE:`* true makes a step stop the job even when continue_independent is used.

### Retry Policy

A step can override the job retry policy:

```json
"RETRY": {
   "MAX_ATTEMPTS": 3,
   "DELAY_MS": 500,
   "BACKOFF": "exponential"
 }
```

`MAX_ATTEMPTS:` includes the first attempt. A value of 3 means one initial attempt and up to two retries.

Supported backoff values are `fixed` and `exponential`.

## REST API Steps

Supported methods:
`
GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS
`


Available parameters:
```
URL
METHOD
HEADERS
QUERY
BODY
TIMEOUT_MS
RESPONSE_TYPE
CAPTURE_RESPONSE_HEADERS
```

`METHOD` defaults to ``GET`` and ``TIMEOUT_MS`` defaults to ``10000``.

Object and array bodies are sent as JSON. GET and HEAD requests cannot contain a body.

`RESPONSE_TYPE` supports auto, json, and text.

A successful request returns:
```json
{
  "status": 200,
  "statusText": "OK",
  "data": {}
}
```

Selected response headers are included when ```CAPTURE_RESPONSE_HEADERS:["content-type",...]``` is provided. Unsuccessful HTTP responses cause
the step to fail.


## API Endpoints

```txt
GET  /api/jobs
GET  /api/jobs/:id
POST /api/jobs/:id/run

GET  /api/logs
GET  /api/logs/:id
```

Example:

```bash
curl -X POST http://localhost:3000/api/jobs/retry-test-001/run
```
  
## Logs

Execution logs are stored in `logs.json`.

A job log contains its status, duration, step results, and error summary.

Each step result contains its status, attempts, duration, output, error, or skip reason.

Possible step statuses are:

```txt
pending
running
success
failed
skipped
cancelled
```

Complete step failure details remain available in `stepResults`.


## Available Step Types

The executor registry currently supports:

```txt
RESTAPI
SCRIPT (JavaScript)
COMMAND (Host Operating System Shell)
PYTHON
```


## Current Security Limitations

This project is currently a proof of concept and is designed to run trusted job definitions.

Do not expose the server to the public internet or allow untrusted users to create or modify jobs.

The following security limitations currently exist:

- `COMMAND` steps run commands through the host operating system shell. They can execute any command available to the
server process.
- `COMMAND` steps inherit the server environment and can define their own working directory and environment variables.
- `SCRIPT` steps use the Node.js `vm` module. It provides an isolated execution context, but it is not a security
sandbox for untrusted code.
- `PYTHON` steps execute Python code with the permissions of the server process.
- `RESTAPI` steps can send requests to any address reachable by the server, including internal services.
  

For the current development stage:

- Only use job definitions whose contents you trust and have reviewed.
- Run the server locally or inside a trusted development environment.
- Run the server with a non-administrator operating system account.
- Do not store passwords, API keys, or other secrets directly in `jobs.json`.