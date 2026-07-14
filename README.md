# Job Framework Usage

## Overview

This project is a Node.js and TypeScript based background job framework.

It allows you to define jobs in `jobs.json`, execute them through an API, handle step dependencies, retry failed steps, and store execution logs in `logs.json`.

## Requirements

Install Node.js first.

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

### Step Dependencies

Use `DEPENDS_ON` to make a step wait for another step.

```json
{
  "ORDER": 2,
  "ID": "550e8400-e29b-41d4-a716-446655440002",
  "NAME": "Parse cat fact",
  "TYPE": "SCRIPT",
  "DEPENDS_ON": ["550e8400-e29b-41d4-a716-446655440001"],
  "STEP_PARAMS": {
    "CODE": "((context) => { const response = context['550e8400-e29b-41d4-a716-446655440001']; return response.data; })"
  }
}
```

Steps without dependencies can run independently.

## Retry Policy

A retry policy can be added to a step.

```json
"RETRY": {
  "COUNT": 3,
  "DELAY_MS": 1000,
  "BACKOFF": "exponential"
}
```

`COUNT` means the number of retries after the first attempt.

Example:

```txt
COUNT: 3
```

means:

```txt
1 initial attempt + 3 retries = 4 total attempts
```

## REST API Timeout

REST API steps can define a timeout.

```json
"STEP_PARAMS": {
  "URL": "https://httpbin.org/delay/10",
  "METHOD": "GET",
  "TIMEOUT_MS": 2000
}
```

If the request takes longer than the timeout, the step fails.

## API Endpoints

### Get All Jobs

```http
GET /api/jobs
```
### Get a Single Job

```
GET /api/jobs/:id
```

```bash
curl -X GET http://localhost:3000/api/jobs
```

### Run a Job

```http
POST /api/jobs/:id/run
```


```bash
curl -X POST http://localhost:3000/api/jobs/retry-test-001/run
```

### Get All Logs

```http
GET /api/logs
```
### Get a Single Log

```
GET /api/logs/:id
```

```bash
curl -X GET http://localhost:3000/api/logs
```

## Logs

Execution logs are stored in:

```txt
logs.json
```

Each log contains:

```txt
logId
jobId
startTime
endTime
durationMs
status
stepResults
error
```

Each step result includes:

```txt
stepId
stepName
stepType
status
startedAt
finishedAt
durationMs
output
error
```

## Available Step Types

The executor registry currently supports:

```txt
RESTAPI
SCRIPT (JavaScript)
COMMAND (Bash Command)
PYTHON
```


