import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { assertSchemaCurrent } from '../src/db/migrations.js';
import { createPool } from '../src/db/pool.js';
import { NotificationRepository } from '../src/repositories/NotificationRepository.js';
import { createSecurityRuntime } from '../src/security/runtime.js';
import type { AuthenticatedActor, SecurityRole } from '../src/types/index.js';

const EXAMPLE_SECRET = 'EXAMPLE_SLACK_WEBHOOK_URL';
const EXAMPLE_CHANNEL = 'Example Slack channel (disabled)';
const EXAMPLE_POLICY = 'Example high-severity failures (disabled)';
const EXAMPLE_AUTOMATION = 'Example success follow-up (disabled)';
const EXAMPLE_TRIGGER = 'Example inbound webhook trigger (disabled)';

interface UserRow {
    id: string;
    email: string;
    display_name: string;
    role: SecurityRole;
    password_change_required: boolean;
}

interface JobRow {
    id: string;
    name: string;
}

const config = loadConfig();
const pool = createPool(config.databaseUrl, config.dbPoolMax);

try {
    await assertSchemaCurrent(pool);

    const actor = await exampleActor();
    const jobs = await exampleJobs();
    const security = createSecurityRuntime(pool, config);
    const notifications = new NotificationRepository(pool);
    const results: string[] = [];

    const secrets = await security.secrets.list();
    if (secrets.some(secret => secret.name === EXAMPLE_SECRET)) {
        results.push(`Managed secret: reused ${EXAMPLE_SECRET}`);
    } else {
        await security.secrets.put(
            EXAMPLE_SECRET,
            'https://example.invalid/workline-demo/slack',
            'Non-routable example Slack webhook for the disabled demo notification channel.',
            actor.userId,
            actor.userId,
            null
        );
        results.push(`Managed secret: created ${EXAMPLE_SECRET}`);
    }

    let channel = (await notifications.listChannels()).find(item => item.name === EXAMPLE_CHANNEL);
    if (channel === undefined) {
        channel = await notifications.createChannel({
            name: EXAMPLE_CHANNEL,
            kind: 'slack',
            endpointSecretName: EXAMPLE_SECRET,
            signingSecretName: null,
            enabled: false
        }, actor);
        results.push(`Notification channel: created ${EXAMPLE_CHANNEL}`);
    } else {
        results.push(`Notification channel: reused ${EXAMPLE_CHANNEL}`);
    }

    const policy = (await notifications.listPolicies()).find(item => item.name === EXAMPLE_POLICY);
    if (policy === undefined) {
        await notifications.createPolicy({
            name: EXAMPLE_POLICY,
            channelId: channel.channelId,
            enabled: false,
            incidentKinds: ['execution_failure', 'webhook_failure'],
            minimumSeverity: 'high',
            jobIds: null,
            lifecycleEvents: ['opened', 'reopened', 'severity_increased', 'resolved']
        }, actor);
        results.push(`Notification policy: created ${EXAMPLE_POLICY}`);
    } else {
        results.push(`Notification policy: reused ${EXAMPLE_POLICY}`);
    }

    const automation = await pool.query<{ id: string }>(
        `SELECT id FROM automation_triggers
         WHERE kind = 'job_completion' AND name = $1
         ORDER BY created_at LIMIT 1`,
        [EXAMPLE_AUTOMATION]
    );
    if (automation.rows[0] === undefined) {
        await pool.query(
            `INSERT INTO automation_triggers(
                id, target_job_id, kind, name, enabled, source_job_id,
                terminal_statuses, created_by_user_id
             ) VALUES ($1, $2, 'job_completion', $3, false, $4, $5, $6)`,
            [randomUUID(), jobs[1]!.id, EXAMPLE_AUTOMATION, jobs[0]!.id, ['success'], actor.userId]
        );
        results.push(`Automation: created ${EXAMPLE_AUTOMATION} (${jobs[0]!.name} -> ${jobs[1]!.name})`);
    } else {
        results.push(`Automation: reused ${EXAMPLE_AUTOMATION}`);
    }

    const trigger = await pool.query<{ id: string }>(
        `SELECT id FROM automation_triggers
         WHERE kind = 'webhook' AND name = $1
         ORDER BY created_at LIMIT 1`,
        [EXAMPLE_TRIGGER]
    );
    if (trigger.rows[0] === undefined) {
        const token = 'bj_hook_' + randomBytes(32).toString('base64url');
        await pool.query(
            `INSERT INTO automation_triggers(
                id, target_job_id, kind, name, enabled, token_hash,
                token_suffix, created_by_user_id
             ) VALUES ($1, $2, 'webhook', $3, false, $4, $5, $6)`,
            [
                randomUUID(),
                jobs[1]!.id,
                EXAMPLE_TRIGGER,
                createHash('sha256').update(token, 'utf8').digest(),
                token.slice(-6),
                actor.userId
            ]
        );
        results.push(`Trigger: created ${EXAMPLE_TRIGGER} (target: ${jobs[1]!.name})`);
    } else {
        results.push(`Trigger: reused ${EXAMPLE_TRIGGER}`);
    }

    console.log('Example records are ready. All executable/delivery records were created disabled.');
    for (const result of results) console.log('- ' + result);
} catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
} finally {
    await pool.end();
}

async function exampleActor(): Promise<AuthenticatedActor> {
    const result = await pool.query<UserRow>(
        `SELECT id, email, display_name, role, password_change_required
         FROM security_users
         WHERE status = 'active'
         ORDER BY CASE role WHEN 'admin' THEN 0 WHEN 'operator' THEN 1 ELSE 2 END,
                  created_at, id
         LIMIT 1`
    );
    const user = result.rows[0];
    if (user === undefined) {
        throw new Error('Create an active user first (npm run auth:bootstrap), then rerun this command.');
    }
    return {
        userId: user.id,
        email: user.email,
        displayName: user.display_name,
        role: user.role,
        authType: 'session',
        credentialId: 'examples-seed-cli',
        passwordChangeRequired: user.password_change_required
    };
}

async function exampleJobs(): Promise<[JobRow, JobRow]> {
    const result = await pool.query<JobRow>(
        'SELECT id, definition->>\'name\' AS name FROM jobs ORDER BY created_at, id LIMIT 2'
    );
    const source = result.rows[0];
    const target = result.rows[1];
    if (source === undefined || target === undefined) {
        throw new Error('At least two jobs are required to create the example job-completion automation.');
    }
    return [source, target];
}
