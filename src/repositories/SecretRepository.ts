import { randomUUID } from 'node:crypto';
import type { DatabasePool } from '../db/pool.js';
import type { ManagedSecretMetadata } from '../types/index.js';

export interface EncryptedSecretRow {
    id: string;
    name: string;
    description: string | null;
    encrypted_value: Buffer;
    nonce: Buffer;
    auth_tag: Buffer;
    key_version: number;
    created_at: Date;
    updated_at: Date;
}

export class SecretRepository {
    constructor(private readonly pool: DatabasePool) {}

    async list(): Promise<ManagedSecretMetadata[]> {
        const result = await this.pool.query<EncryptedSecretRow>(
            'SELECT * FROM managed_secrets ORDER BY name'
        );
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
    }): Promise<ManagedSecretMetadata> {
        const result = await this.pool.query<EncryptedSecretRow>(
            `INSERT INTO managed_secrets(
                id, name, description, encrypted_value, nonce, auth_tag, created_by_user_id
             ) VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (name) DO UPDATE
             SET description = EXCLUDED.description,
                 encrypted_value = EXCLUDED.encrypted_value,
                 nonce = EXCLUDED.nonce,
                 auth_tag = EXCLUDED.auth_tag,
                 key_version = managed_secrets.key_version + 1,
                 updated_at = clock_timestamp()
             RETURNING *`,
            [
                randomUUID(), input.name, input.description, input.encryptedValue,
                input.nonce, input.authTag, input.createdByUserId
            ]
        );
        return mapSecretMetadata(result.rows[0]!);
    }

    async delete(name: string): Promise<boolean> {
        const result = await this.pool.query('DELETE FROM managed_secrets WHERE name = $1', [name]);
        return (result.rowCount ?? 0) > 0;
    }
}

function mapSecretMetadata(row: EncryptedSecretRow): ManagedSecretMetadata {
    return {
        secretId: row.id,
        name: row.name,
        description: row.description,
        keyVersion: row.key_version,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString()
    };
}
