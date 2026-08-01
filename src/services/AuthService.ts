import { createHash, randomBytes } from 'node:crypto';
import { AppError } from '../errors.js';
import { AuditRepository } from '../repositories/AuditRepository.js';
import { SecurityRepository, type UserCredential } from '../repositories/SecurityRepository.js';
import type {
    ApiTokenSummary,
    AuthenticatedActor,
    SecurityRole,
    SecurityUser,
    SecurityUserStatus,
    UserAccessSummary
} from '../types/index.js';
import { assertPasswordPolicy, hashPassword, verifyPassword } from '../security/password.js';
import { permissionsForRole } from '../security/permissions.js';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const ROLES = new Set<SecurityRole>(['viewer', 'operator', 'admin']);
const STATUSES = new Set<SecurityUserStatus>(['active', 'disabled']);

export interface LoginContext {
    requestId: string;
    ipAddress: string | null;
    userAgent: string | null;
}

export interface LoginResult {
    actor: AuthenticatedActor;
    sessionToken: string;
    csrfToken: string;
    expiresAt: string;
}

export class AuthService {
    private readonly dummyHash: Promise<string>;

    constructor(
        private readonly security: SecurityRepository,
        private readonly audit: AuditRepository,
        private readonly sessionTtlMs: number,
        private readonly sessionIdleMs: number
    ) {
        this.dummyHash = hashPassword('invalid-password-' + randomBytes(16).toString('hex'));
    }

    async login(emailValue: unknown, passwordValue: unknown, context: LoginContext): Promise<LoginResult> {
        const email = typeof emailValue === 'string' ? emailValue.trim().toLowerCase().slice(0, 254) : '';
        const password = typeof passwordValue === 'string' ? passwordValue : '';
        const credential = email.length === 0 ? undefined : await this.security.getUserByEmail(email);
        const passwordHash = credential?.passwordHash ?? await this.dummyHash;
        const validPassword = await verifyPassword(password, passwordHash);
        const locked = credential?.lockedUntilDate !== null &&
            credential?.lockedUntilDate !== undefined &&
            credential.lockedUntilDate.getTime() > Date.now();
        const valid = credential !== undefined &&
            credential.status === 'active' &&
            !locked &&
            validPassword;

        if (!valid) {
            if (credential !== undefined && credential.status === 'active' && !locked) {
                await this.security.recordLoginFailure(credential.userId);
            }
            await this.audit.record({
                requestId: context.requestId,
                actorType: 'anonymous',
                actorLabel: email || 'unknown',
                action: 'auth.login',
                outcome: 'failure',
                statusCode: 401,
                ipAddress: context.ipAddress,
                userAgent: context.userAgent
            });
            throw new AppError('INVALID_CREDENTIALS', 'Email or password is incorrect.', 401);
        }

        await this.security.recordLoginSuccess(credential.userId);
        const sessionToken = randomBytes(32).toString('base64url');
        const csrfToken = randomBytes(32).toString('base64url');
        const now = Date.now();
        const expiresAt = new Date(now + this.sessionTtlMs);
        const idleExpiresAt = new Date(Math.min(expiresAt.getTime(), now + this.sessionIdleMs));
        const sessionId = await this.security.createSession({
            userId: credential.userId,
            tokenHash: hashToken(sessionToken),
            csrfTokenHash: hashToken(csrfToken),
            expiresAt,
            idleExpiresAt,
            ipAddress: context.ipAddress,
            userAgent: context.userAgent
        });
        const actor: AuthenticatedActor = {
            userId: credential.userId,
            email: credential.email,
            displayName: credential.displayName,
            role: credential.role,
            authType: 'session',
            credentialId: sessionId,
            passwordChangeRequired: credential.passwordChangeRequired
        };
        await this.audit.record({
            requestId: context.requestId,
            actor,
            action: 'auth.login',
            outcome: 'success',
            statusCode: 200,
            ipAddress: context.ipAddress,
            userAgent: context.userAgent
        });
        return { actor, sessionToken, csrfToken, expiresAt: expiresAt.toISOString() };
    }

    async authenticateSession(sessionToken: string): Promise<{
        actor: AuthenticatedActor;
        sessionId: string;
        csrfTokenHash: Buffer;
    } | undefined> {
        return this.security.authenticateSession(hashToken(sessionToken), this.sessionIdleMs);
    }

    async authenticateApiToken(token: string): Promise<AuthenticatedActor | undefined> {
        if (!token.startsWith('bj_pat_') || token.length > 256) return undefined;
        return this.security.authenticateApiToken(hashToken(token));
    }

    async logout(sessionId: string): Promise<void> {
        await this.security.revokeSession(sessionId);
    }

    me(actor: AuthenticatedActor): Record<string, unknown> {
        return {
            user: {
                userId: actor.userId,
                email: actor.email,
                displayName: actor.displayName,
                role: actor.role
            },
            authType: actor.authType,
            passwordChangeRequired: actor.passwordChangeRequired,
            permissions: permissionsForRole(actor.role)
        };
    }

    async createUser(input: unknown, passwordChangeRequired = true): Promise<SecurityUser> {
        const record = requireRecord(input, 'User request body must be an object.');
        rejectUnsupported(record, new Set(['email', 'displayName', 'password', 'role']));
        const email = normalizeEmail(record.email);
        const displayName = normalizeDisplayName(record.displayName);
        const role = normalizeRole(record.role);
        assertPasswordPolicy(record.password);
        try {
            return await this.security.createUser({
                email,
                displayName,
                role,
                passwordHash: await hashPassword(record.password),
                passwordChangeRequired
            });
        } catch (error: unknown) {
            if (isUniqueViolation(error)) {
                throw new AppError('USER_EMAIL_EXISTS', 'A user with that email already exists.', 409);
            }
            throw error;
        }
    }

    async bootstrapAdmin(email: unknown, displayName: unknown, password: unknown): Promise<SecurityUser> {
        if ((await this.security.listUsers()).length > 0) {
            throw new AppError('BOOTSTRAP_NOT_ALLOWED', 'Bootstrap is allowed only when no users exist.', 409);
        }
        return this.createUser({ email, displayName, password, role: 'admin' }, false);
    }

    async listUsers(): Promise<SecurityUser[]> {
        return this.security.listUsers();
    }

    async updateUser(userId: string, input: unknown): Promise<SecurityUser> {
        const existing = await this.security.getUserById(userId);
        if (existing === undefined) throw new AppError('USER_NOT_FOUND', 'User was not found.', 404);
        const record = requireRecord(input, 'User update body must be an object.');
        rejectUnsupported(record, new Set(['displayName', 'role', 'status']));
        const displayName = record.displayName === undefined
            ? existing.displayName
            : normalizeDisplayName(record.displayName);
        const role = record.role === undefined ? existing.role : normalizeRole(record.role);
        const status = record.status === undefined ? existing.status : normalizeStatus(record.status);
        const updated = await this.security.updateUser(userId, { displayName, role, status });
        if (updated === undefined) throw new AppError('USER_NOT_FOUND', 'User was not found.', 404);
        if (status === 'disabled') await this.security.revokeUserAccess(userId);
        return updated;
    }

    async resetPassword(userId: string, password: unknown): Promise<void> {
        assertPasswordPolicy(password);
        if (!(await this.security.setPassword(userId, await hashPassword(password), true))) {
            throw new AppError('USER_NOT_FOUND', 'User was not found.', 404);
        }
    }

    async changeOwnPassword(actor: AuthenticatedActor, currentPassword: unknown, newPassword: unknown): Promise<void> {
        if (typeof currentPassword !== 'string') {
            throw new AppError('INVALID_CURRENT_PASSWORD', 'Current password is required.', 422);
        }
        assertPasswordPolicy(newPassword);
        const user = await this.security.getUserById(actor.userId);
        if (user === undefined || !(await verifyPassword(currentPassword, user.passwordHash))) {
            throw new AppError('INVALID_CURRENT_PASSWORD', 'Current password is incorrect.', 401);
        }
        await this.security.setPassword(actor.userId, await hashPassword(newPassword));
    }

    async createApiToken(actor: AuthenticatedActor, input: unknown): Promise<{
        token: string;
        item: ApiTokenSummary;
    }> {
        const record = requireRecord(input, 'API token request body must be an object.');
        rejectUnsupported(record, new Set(['name', 'expiresAt']));
        const name = normalizeTokenName(record.name);
        const expiresAt = normalizeTokenExpiry(record.expiresAt);
        const token = 'bj_pat_' + randomBytes(32).toString('base64url');
        const item = await this.security.createApiToken({
            userId: actor.userId,
            name,
            tokenHash: hashToken(token),
            expiresAt
        });
        return { token, item };
    }

    async listApiTokens(actor: AuthenticatedActor): Promise<ApiTokenSummary[]> {
        return this.security.listApiTokens(actor.userId);
    }

    async revokeApiToken(actor: AuthenticatedActor, tokenId: string): Promise<void> {
        if (!(await this.security.revokeApiToken(actor.userId, tokenId))) {
            throw new AppError('API_TOKEN_NOT_FOUND', 'API token was not found or was already revoked.', 404);
        }
    }

    roles(): Array<{ role: SecurityRole; permissions: string[] }> {
        return (['viewer', 'operator', 'admin'] as const).map(role => ({
            role,
            permissions: permissionsForRole(role)
        }));
    }

    async getUserAccess(userId: string): Promise<UserAccessSummary> {
        await this.requireUser(userId);
        return this.security.listUserAccess(userId);
    }

    async unlockUser(userId: string): Promise<SecurityUser> {
        await this.requireUser(userId);
        await this.security.unlockUser(userId);
        return (await this.security.getUserById(userId))!;
    }

    async revokeUserAccess(userId: string): Promise<{ sessionsRevoked: number; tokensRevoked: number }> {
        await this.requireUser(userId);
        return this.security.revokeUserAccess(userId);
    }

    async revokeUserSession(userId: string, sessionId: string): Promise<void> {
        await this.requireUser(userId);
        if (!(await this.security.revokeUserSession(userId, sessionId))) {
            throw new AppError('SESSION_NOT_FOUND', 'Session was not found.', 404);
        }
    }

    async revokeUserApiToken(userId: string, tokenId: string): Promise<void> {
        await this.requireUser(userId);
        if (!(await this.security.revokeApiToken(userId, tokenId))) {
            throw new AppError('API_TOKEN_NOT_FOUND', 'API token was not found or was already revoked.', 404);
        }
    }

    private async requireUser(userId: string): Promise<UserCredential> {
        const user = await this.security.getUserById(userId);
        if (user === undefined) throw new AppError('USER_NOT_FOUND', 'User was not found.', 404);
        return user;
    }
}

export function hashToken(value: string): Buffer {
    return createHash('sha256').update(value, 'utf8').digest();
}

function normalizeEmail(value: unknown): string {
    if (typeof value !== 'string') throw new AppError('INVALID_EMAIL', 'Email must be a string.', 422);
    const email = value.trim().toLowerCase();
    if (email.length > 254 || !EMAIL_PATTERN.test(email)) {
        throw new AppError('INVALID_EMAIL', 'Email must be a valid address.', 422);
    }
    return email;
}

function normalizeDisplayName(value: unknown): string {
    if (typeof value !== 'string') throw new AppError('INVALID_DISPLAY_NAME', 'Display name must be a string.', 422);
    const name = value.trim();
    if (name.length < 1 || name.length > 100) {
        throw new AppError('INVALID_DISPLAY_NAME', 'Display name must contain between 1 and 100 characters.', 422);
    }
    return name;
}

function normalizeRole(value: unknown): SecurityRole {
    if (typeof value !== 'string' || !ROLES.has(value as SecurityRole)) {
        throw new AppError('INVALID_ROLE', 'Role must be viewer, operator, or admin.', 422);
    }
    return value as SecurityRole;
}

function normalizeStatus(value: unknown): SecurityUserStatus {
    if (typeof value !== 'string' || !STATUSES.has(value as SecurityUserStatus)) {
        throw new AppError('INVALID_USER_STATUS', 'User status must be active or disabled.', 422);
    }
    return value as SecurityUserStatus;
}

function normalizeTokenName(value: unknown): string {
    if (typeof value !== 'string') throw new AppError('INVALID_TOKEN_NAME', 'Token name must be a string.', 422);
    const name = value.trim();
    if (name.length < 1 || name.length > 100) {
        throw new AppError('INVALID_TOKEN_NAME', 'Token name must contain between 1 and 100 characters.', 422);
    }
    return name;
}

function normalizeTokenExpiry(value: unknown): Date | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string') throw new AppError('INVALID_TOKEN_EXPIRY', 'expiresAt must be an ISO timestamp.', 422);
    const timestamp = Date.parse(value);
    const maximum = Date.now() + 366 * 24 * 60 * 60 * 1_000;
    if (Number.isNaN(timestamp) || timestamp <= Date.now() || timestamp > maximum) {
        throw new AppError('INVALID_TOKEN_EXPIRY', 'expiresAt must be in the future and no more than 366 days away.', 422);
    }
    return new Date(timestamp);
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new AppError('INVALID_REQUEST_BODY', message, 422);
    }
    return value as Record<string, unknown>;
}

function rejectUnsupported(record: Record<string, unknown>, allowed: ReadonlySet<string>): void {
    const unsupported = Object.keys(record).find(key => !allowed.has(key));
    if (unsupported !== undefined) {
        throw new AppError('UNSUPPORTED_FIELD', 'Unsupported request field: ' + unsupported + '.', 422);
    }
}

function isUniqueViolation(error: unknown): boolean {
    return error instanceof Error && 'code' in error && error.code === '23505';
}
