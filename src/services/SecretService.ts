import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { AppError } from '../errors.js';
import { SecretRepository } from '../repositories/SecretRepository.js';
import type { Job, ManagedSecretMetadata, SecretUsage } from '../types/index.js';

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
        actorUserId: string,
        rawOwnerUserId?: unknown,
        rawExpiresOn?: unknown
    ): Promise<ManagedSecretMetadata> {
        const name = normalizeSecretName(rawName);
        if (typeof rawValue !== 'string' || rawValue.length === 0 || rawValue.length > 65_536) {
            throw new AppError('INVALID_SECRET_VALUE', 'Secret value must contain between 1 and 65536 characters.', 422);
        }
        const description = normalizeDescription(rawDescription);
        const existing = await this.secrets.getByName(name);
        const ownerUserId = rawOwnerUserId === undefined
            ? existing?.owner_user_id ?? actorUserId
            : normalizeOwnerUserId(rawOwnerUserId);
        if (ownerUserId !== null && !(await this.secrets.userExists(ownerUserId))) {
            throw new AppError('SECRET_OWNER_NOT_FOUND', 'The selected secret owner was not found.', 422);
        }
        const expiresOn = normalizeExpiresOn(rawExpiresOn);
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
            createdByUserId: actorUserId,
            ownerUserId,
            lastRotatedByUserId: actorUserId,
            expiresOn
        });
    }

    async usage(rawName: unknown): Promise<SecretUsage[]> {
        const name = normalizeSecretName(rawName);
        if ((await this.secrets.getByName(name)) === undefined) {
            throw new AppError('SECRET_NOT_FOUND', 'Managed secret ' + name + ' was not found.', 404);
        }
        return this.secrets.usage(name);
    }

    async delete(rawName: unknown, force = false): Promise<void> {
        const name = normalizeSecretName(rawName);
        const result = await this.secrets.delete(name, force);
        if (result.status === 'not_found') {
            throw new AppError('SECRET_NOT_FOUND', 'Managed secret ' + name + ' was not found.', 404);
        }
        if (result.status === 'in_use') {
            throw new AppError(
                'SECRET_IN_USE',
                'Managed secret ' + name + ' is still referenced by one or more jobs.',
                409,
                { usage: result.usage }
            );
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

function normalizeOwnerUserId(value: unknown): string | null {
    if (value === null) return null;
    if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
        throw new AppError('INVALID_SECRET_OWNER', 'ownerUserId must be a user UUID or null.', 422);
    }
    return value;
}

function normalizeExpiresOn(value: unknown): string | null {
    if (value === null) return null;
    if (value === undefined) return dateAfterDays(90);
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
        throw new AppError('INVALID_SECRET_EXPIRY', 'expiresOn must be a YYYY-MM-DD date or null.', 422);
    }
    const parsed = new Date(value + 'T00:00:00.000Z');
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value || value < today()) {
        throw new AppError('INVALID_SECRET_EXPIRY', 'expiresOn must be today or a future calendar date.', 422);
    }
    return value;
}

function dateAfterDays(days: number): string {
    const date = new Date();
    date.setUTCHours(0, 0, 0, 0);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
}

function today(): string {
    return new Date().toISOString().slice(0, 10);
}
