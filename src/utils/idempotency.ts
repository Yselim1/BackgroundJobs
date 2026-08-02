import { createHash } from 'node:crypto';
import { AppError } from '../errors.js';
import type { AuthenticatedActor } from '../types/index.js';

const MAX_KEY_BYTES = 200;

export function parseIdempotencyKey(value: string | undefined): string | undefined {
    if (value === undefined) return undefined;
    const key = value.trim();
    if (key.length === 0 || Buffer.byteLength(key, 'utf8') > MAX_KEY_BYTES) {
        throw new AppError('INVALID_IDEMPOTENCY_KEY', `Idempotency-Key must contain between 1 and ${MAX_KEY_BYTES} UTF-8 bytes.`, 400);
    }
    return key;
}

export function idempotencyHashes(actor: AuthenticatedActor, key: string, request: unknown): {
    actorScopeHash: Buffer;
    keyHash: Buffer;
    requestHash: Buffer;
} {
    return {
        actorScopeHash: digest(`${actor.authType}:${actor.credentialId}:${actor.userId}`),
        keyHash: digest(key),
        requestHash: digest(stableJson(request))
    };
}

export function stableJson(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
    return `{${Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([first], [second]) => first.localeCompare(second))
        .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
}

function digest(value: string): Buffer {
    return createHash('sha256').update(value, 'utf8').digest();
}
