import { randomUUID } from 'node:crypto';
import type { DatabaseClient, DatabasePool } from '../db/pool.js';
import { withTransaction } from '../db/pool.js';
import type { Job, ManagedSecretMetadata, SecretUsage, SecretUsageReference } from '../types/index.js';

export interface EncryptedSecretRow {
    id: string;
    name: string;
    description: string | null;
    encrypted_value: Buffer;
    nonce: Buffer;
    auth_tag: Buffer;
    key_version: number;
    created_by_user_id: string | null;
    owner_user_id: string | null;
    last_rotated_by_user_id: string | null;
    expires_on: string | Date | null;
    created_at: Date;
    updated_at: Date;
}

interface SecretMetadataRow extends EncryptedSecretRow {
    owner_display_name: string | null;
    owner_email: string | null;
    rotated_display_name: string | null;
    rotated_email: string | null;
}

interface JobRow {
    id: string;
    definition: Job;
    status: 'active' | 'inactive';
}

export type SecretDeleteResult =
    | { status: 'deleted' }
    | { status: 'not_found' }
    | { status: 'in_use'; usage: SecretUsage[] };

const TEMPLATE = /\{\{\s*secrets\.([A-Z][A-Z0-9_]{1,63})\s*\}\}/gu;

export class SecretRepository {
    constructor(private readonly pool: DatabasePool) {}

    async list(): Promise<ManagedSecretMetadata[]> {
        const result = await this.pool.query<SecretMetadataRow>(metadataQuery('ORDER BY secret.name'));
        return result.rows.map(mapSecretMetadata);
    }

    async getByName(name: string): Promise<EncryptedSecretRow | undefined> {
        const result = await this.pool.query<EncryptedSecretRow>(
            'SELECT * FROM managed_secrets WHERE name = $1',
            [name]
        );
        return result.rows[0];
    }

    async upsert(input: {
        name: string;
        description: string | null;
        encryptedValue: Buffer;
        nonce: Buffer;
        authTag: Buffer;
        createdByUserId: string;
        ownerUserId: string | null;
        lastRotatedByUserId: string;
        expiresOn: string | null;
    }): Promise<ManagedSecretMetadata> {
        await this.pool.query(
            `INSERT INTO managed_secrets(
                id, name, description, encrypted_value, nonce, auth_tag, created_by_user_id,
                owner_user_id, last_rotated_by_user_id, expires_on
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::date)
             ON CONFLICT (name) DO UPDATE
             SET description = EXCLUDED.description,
                 encrypted_value = EXCLUDED.encrypted_value,
                 nonce = EXCLUDED.nonce,
                 auth_tag = EXCLUDED.auth_tag,
                 owner_user_id = EXCLUDED.owner_user_id,
                 last_rotated_by_user_id = EXCLUDED.last_rotated_by_user_id,
                 expires_on = EXCLUDED.expires_on,
                 key_version = managed_secrets.key_version + 1,
                 updated_at = clock_timestamp()`,
            [
                randomUUID(), input.name, input.description, input.encryptedValue,
                input.nonce, input.authTag, input.createdByUserId, input.ownerUserId,
                input.lastRotatedByUserId, input.expiresOn
            ]
        );
        const result = await this.pool.query<SecretMetadataRow>(
            metadataQuery('WHERE secret.name = $1'),
            [input.name]
        );
        return mapSecretMetadata(result.rows[0]!);
    }

    async usage(name: string): Promise<SecretUsage[]> {
        return listUsage(this.pool, name);
    }

    async userExists(userId: string): Promise<boolean> {
        const result = await this.pool.query('SELECT 1 FROM security_users WHERE id = $1', [userId]);
        return (result.rowCount ?? 0) > 0;
    }

    async delete(name: string, force: boolean): Promise<SecretDeleteResult> {
        return withTransaction(this.pool, async client => {
            await client.query('LOCK TABLE jobs IN SHARE MODE');
            const usage = await listUsage(client, name);
            if (usage.length > 0 && !force) return { status: 'in_use', usage };
            const result = await client.query('DELETE FROM managed_secrets WHERE name = $1', [name]);
            return (result.rowCount ?? 0) === 0 ? { status: 'not_found' } : { status: 'deleted' };
        });
    }
}

function metadataQuery(suffix: string): string {
    return `SELECT secret.*,
                   owner.display_name AS owner_display_name,
                   owner.email AS owner_email,
                   rotated.display_name AS rotated_display_name,
                   rotated.email AS rotated_email
            FROM managed_secrets AS secret
            LEFT JOIN security_users AS owner ON owner.id = secret.owner_user_id
            LEFT JOIN security_users AS rotated ON rotated.id = secret.last_rotated_by_user_id
            ${suffix}`;
}

async function listUsage(client: Pick<DatabaseClient, 'query'>, name: string): Promise<SecretUsage[]> {
    const result = await client.query<JobRow>(
        'SELECT id, definition, status FROM jobs ORDER BY lower(id), id'
    );
    const usage: SecretUsage[] = [];
    for (const row of result.rows) {
        const references: SecretUsageReference[] = [];
        visitTemplates(row.definition, '$', name, references);
        for (const [index, webhook] of (row.definition.WEBHOOKS ?? []).entries()) {
            if (webhook.SIGNING_SECRET === name) {
                references.push({ kind: 'webhook_signing', path: `$.WEBHOOKS[${index}].SIGNING_SECRET` });
            }
        }
        if (references.length > 0) {
            usage.push({
                jobId: row.id,
                jobName: row.definition.name,
                jobStatus: row.status,
                references
            });
        }
    }
    return usage;
}

function visitTemplates(
    value: unknown,
    path: string,
    name: string,
    references: SecretUsageReference[]
): void {
    if (typeof value === 'string') {
        for (const match of value.matchAll(TEMPLATE)) {
            if (match[1] === name) references.push({ kind: 'runtime_template', path });
        }
        return;
    }
    if (Array.isArray(value)) {
        value.forEach((item, index) => visitTemplates(item, `${path}[${index}]`, name, references));
        return;
    }
    if (value !== null && typeof value === 'object') {
        for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
            visitTemplates(item, `${path}.${key}`, name, references);
        }
    }
}

function mapSecretMetadata(row: SecretMetadataRow): ManagedSecretMetadata {
    return {
        secretId: row.id,
        name: row.name,
        description: row.description,
        keyVersion: row.key_version,
        owner: row.owner_user_id === null ? null : {
            userId: row.owner_user_id,
            displayName: row.owner_display_name ?? 'Former user',
            email: row.owner_email ?? 'Unavailable'
        },
        lastRotatedBy: row.last_rotated_by_user_id === null ? null : {
            userId: row.last_rotated_by_user_id,
            displayName: row.rotated_display_name ?? 'Former user',
            email: row.rotated_email ?? 'Unavailable'
        },
        expiresOn: dateText(row.expires_on),
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString()
    };
}

function dateText(value: string | Date | null): string | null {
    if (value === null) return null;
    return typeof value === 'string' ? value.slice(0, 10) : value.toISOString().slice(0, 10);
}
