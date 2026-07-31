import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';
import { AppError } from '../errors.js';

const MEMORY_KIB = 19_456;
const PASSES = 2;
const PARALLELISM = 1;
const TAG_LENGTH = 32;
const HASH_PATTERN = /^argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/u;

export function assertPasswordPolicy(password: unknown): asserts password is string {
    if (typeof password !== 'string') {
        throw new AppError('INVALID_PASSWORD', 'Password must be a string.', 422);
    }
    if (password.length < 12) {
        throw new AppError('WEAK_PASSWORD', 'Password must contain at least 12 characters.', 422);
    }
    if (password.length > 256) {
        throw new AppError('INVALID_PASSWORD', 'Password must contain at most 256 characters.', 422);
    }
}

export async function hashPassword(password: string): Promise<string> {
    const salt = randomBytes(16);
    const derived = await derive(password, salt, MEMORY_KIB, PASSES, PARALLELISM);
    return [
        'argon2id',
        'v=19',
        'm=' + MEMORY_KIB + ',t=' + PASSES + ',p=' + PARALLELISM,
        salt.toString('base64url'),
        derived.toString('base64url')
    ].join('$');
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
    const match = HASH_PATTERN.exec(encoded);
    if (match === null) return false;
    const memory = Number(match[1]);
    const passes = Number(match[2]);
    const parallelism = Number(match[3]);
    const salt = Buffer.from(match[4] as string, 'base64url');
    const expected = Buffer.from(match[5] as string, 'base64url');
    if (salt.length < 8 || expected.length < 16) return false;
    try {
        const actual = await derive(password, salt, memory, passes, parallelism, expected.length);
        return actual.length === expected.length && timingSafeEqual(actual, expected);
    } catch {
        return false;
    }
}

function derive(
    password: string,
    salt: Buffer,
    memory: number,
    passes: number,
    parallelism: number,
    tagLength = TAG_LENGTH
): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        argon2('argon2id', {
            message: Buffer.from(password, 'utf8'),
            nonce: salt,
            parallelism,
            tagLength,
            memory,
            passes
        }, (error, derivedKey) => {
            if (error !== null) reject(error);
            else resolve(derivedKey);
        });
    });
}
