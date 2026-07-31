import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { AppError } from '../errors.js';
import { SecretRepository } from '../repositories/SecretRepository.js';
import type { Job, ManagedSecretMetadata } from '../types/index.js';

const SECRET_NAME = /^[A-Z][A-Z0-9_]{1,63}$/u;
const SECRET_TEMPLATE = /\{\{\s*secrets\.([A-Z][A-Z0-9_]{1,63})\s*\}\}/gu;

export class SecretService {
    private readonly key: Buffer | undefined;

    constructor(private readonly secrets: SecretRepository, masterKey?: string) {
        this.key = masterKey === undefined ? undefined : Buffer.from(masterKey, 'base64');
    }

    get configured(): boolean { return this.key !== undefined; }

    async list(): Promise<ManagedSecretMetadata[]> {
        return this.secrets.list();
    }

    async put(
        rawName: unknown,
        rawValue: unknown,
        rawDescription: unknown,
        actorUserId: string
    ): Promise<ManagedSecretMetadata> {
        const name = normalizeSecretName(rawName);
        if (typeof rawValue !== 'string' || rawValue.length === 0 || rawValue.length > 65_536) {
            throw new AppError('INVALID_SECRET_VALUE', 'Secret value must contain between 1 and 65536 characters.', 422);
        }
        const description = normalizeDescription(rawDescription);
        const key = this.requireKey();
        const nonce = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', key, nonce);
        cipher.setAAD(Buffer.from(name, 'utf8'));
        const encryptedValue = Buffer.concat([cipher.update(rawValue, 'utf8'), cipher.final()]);
        return this.secrets.upsert({
            name,
            description,
            encryptedValue,
            nonce,
            authTag: cipher.getAuthTag(),
            createdByUserId: actorUserId
        });
    }

    async delete(rawName: unknown): Promise<void> {
        const name = normalizeSecretName(rawName);
        if (!(await this.secrets.delete(name))) {
            throw new AppError('SECRET_NOT_FOUND', 'Managed secret ' + name + ' was not found.', 404);
        }
    }

    async resolve(rawName: unknown): Promise<string> {
        const name = normalizeSecretName(rawName);
        const key = this.requireKey();
        const row = await this.secrets.getByName(name);
        if (row === undefined) {
            throw new AppError('SECRET_NOT_FOUND', 'Managed secret ' + name + ' was not found.', 422);
        }
        try {
            const decipher = createDecipheriv('aes-256-gcm', key, row.nonce);
            decipher.setAAD(Buffer.from(name, 'utf8'));
            decipher.setAuthTag(row.auth_tag);
            return Buffer.concat([decipher.update(row.encrypted_value), decipher.final()]).toString('utf8');
        } catch {
            throw new AppError('SECRET_DECRYPTION_FAILED', 'Managed secret ' + name + ' could not be decrypted.', 500);
        }
    }

    async resolveForJob(job: Job): Promise<Record<string, string>> {
        const names = extractSecretReferences(job);
        const values = await Promise.all([...names].map(async name => [name, await this.resolve(name)] as const));
        return Object.fromEntries(values);
    }

    private requireKey(): Buffer {
        if (this.key === undefined) {
            throw new AppError(
                'SECRETS_MASTER_KEY_REQUIRED',
                'SECRETS_MASTER_KEY must be configured before managed secrets can be stored or resolved.',
                503
            );
        }
        return this.key;
    }
}

export function normalizeSecretName(value: unknown): string {
    if (typeof value !== 'string') throw new AppError('INVALID_SECRET_NAME', 'Secret name must be a string.', 422);
    const name = value.trim().toUpperCase();
    if (!SECRET_NAME.test(name)) {
        throw new AppError(
            'INVALID_SECRET_NAME',
            'Secret names must contain 2-64 uppercase letters, digits, or underscores and begin with a letter.',
            422
        );
    }
    return name;
}

export function extractSecretReferences(value: unknown): Set<string> {
    const names = new Set<string>();
    visit(value, names);
    return names;
}

function visit(value: unknown, names: Set<string>): void {
    if (typeof value === 'string') {
        for (const match of value.matchAll(SECRET_TEMPLATE)) names.add(match[1] as string);
        return;
    }
    if (Array.isArray(value)) {
        for (const item of value) visit(item, names);
        return;
    }
    if (value !== null && typeof value === 'object') {
        for (const item of Object.values(value as Record<string, unknown>)) visit(item, names);
    }
}

function normalizeDescription(value: unknown): string | null {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string' || value.length > 500) {
        throw new AppError('INVALID_SECRET_DESCRIPTION', 'Secret description must contain at most 500 characters.', 422);
    }
    return value.trim() || null;
}
