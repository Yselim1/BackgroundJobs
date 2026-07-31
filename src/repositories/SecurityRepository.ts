import { randomUUID } from 'node:crypto';
import type { DatabasePool } from '../db/pool.js';
import { withTransaction } from '../db/pool.js';
import { AppError } from '../errors.js';
import type {
    ApiTokenSummary,
    AuthenticatedActor,
    SecurityRole,
    SecurityUser,
    SecurityUserStatus
} from '../types/index.js';

interface UserRow {
    id: string;
    email: string;
    display_name: string;
    password_hash: string;
    role: SecurityRole;
    status: SecurityUserStatus;
    failed_login_attempts: number;
    locked_until: Date | null;
    last_login_at: Date | null;
    password_changed_at: Date;
    created_at: Date;
    updated_at: Date;
}

interface SessionAuthenticationRow extends UserRow {
    session_id: string;
    csrf_token_hash: Buffer;
}

interface TokenAuthenticationRow extends UserRow {
    token_id: string;
}

interface ApiTokenRow {
    id: string;
    name: string;
    expires_at: Date | null;
    last_used_at: Date | null;
    revoked_at: Date | null;
    created_at: Date;
}

export interface UserCredential extends SecurityUser {
    passwordHash: string;
    failedLoginAttempts: number;
    lockedUntil: Date | null;
}

export interface SessionAuthentication {
    actor: AuthenticatedActor;
    sessionId: string;
    csrfTokenHash: Buffer;
}

export class SecurityRepository {
    constructor(private readonly pool: DatabasePool) {}

    async createUser(input: {
        email: string;
        displayName: string;
        passwordHash: string;
        role: SecurityRole;
    }): Promise<SecurityUser> {
        const result = await this.pool.query<UserRow>(
            `INSERT INTO security_users(id, email, display_name, password_hash, role)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING *`,
            [randomUUID(), input.email, input.displayName, input.passwordHash, input.role]
        );
        return mapUser(result.rows[0]!);
    }

    async getUserById(userId: string): Promise<UserCredential | undefined> {
        const result = await this.pool.query<UserRow>('SELECT * FROM security_users WHERE id = $1', [userId]);
        return result.rows[0] === undefined ? undefined : mapCredential(result.rows[0]);
    }

    async getUserByEmail(email: string): Promise<UserCredential | undefined> {
        const result = await this.pool.query<UserRow>(
            'SELECT * FROM security_users WHERE lower(email) = lower($1)',
            [email]
        );
        return result.rows[0] === undefined ? undefined : mapCredential(result.rows[0]);
    }

    async listUsers(): Promise<SecurityUser[]> {
        const result = await this.pool.query<UserRow>(
            'SELECT * FROM security_users ORDER BY lower(email), id'
        );
        return result.rows.map(mapUser);
    }

    async countActiveAdmins(): Promise<number> {
        const result = await this.pool.query<{ count: string }>(
            `SELECT count(*)::text AS count FROM security_users
             WHERE role = 'admin' AND status = 'active'`
        );
        return Number(result.rows[0]?.count ?? 0);
    }

    async updateUser(
        userId: string,
        input: { displayName: string; role: SecurityRole; status: SecurityUserStatus }
    ): Promise<SecurityUser | undefined> {
        return withTransaction(this.pool, async client => {
            await client.query('LOCK TABLE security_users IN SHARE ROW EXCLUSIVE MODE');
            const currentResult = await client.query<UserRow>(
                'SELECT * FROM security_users WHERE id = $1 FOR UPDATE',
                [userId]
            );
            const current = currentResult.rows[0];
            if (current === undefined) return undefined;
            const removesActiveAdmin = current.role === 'admin' &&
                current.status === 'active' &&
                (input.role !== 'admin' || input.status !== 'active');
            if (removesActiveAdmin) {
                const count = await client.query<{ count: string }>(
                    `SELECT count(*)::text AS count FROM security_users
                     WHERE role = 'admin' AND status = 'active'`
                );
                if (Number(count.rows[0]?.count ?? 0) <= 1) {
                    throw new AppError(
                        'LAST_ADMIN_REQUIRED',
                        'The final active administrator cannot be disabled or demoted.',
                        409
                    );
                }
            }
            const result = await client.query<UserRow>(
                `UPDATE security_users
                 SET display_name = $2, role = $3, status = $4, updated_at = clock_timestamp()
                 WHERE id = $1
                 RETURNING *`,
                [userId, input.displayName, input.role, input.status]
            );
            return mapUser(result.rows[0]!);
        });
    }

    async setPassword(userId: string, passwordHash: string): Promise<boolean> {
        return withTransaction(this.pool, async client => {
            const result = await client.query(
                `UPDATE security_users
                 SET password_hash = $2, password_changed_at = clock_timestamp(),
                     failed_login_attempts = 0, locked_until = NULL,
                     updated_at = clock_timestamp()
                 WHERE id = $1`,
                [userId, passwordHash]
            );
            if ((result.rowCount ?? 0) === 0) return false;
            await client.query('DELETE FROM security_sessions WHERE user_id = $1', [userId]);
            await client.query(
                `UPDATE security_api_tokens SET revoked_at = clock_timestamp()
                 WHERE user_id = $1 AND revoked_at IS NULL`,
                [userId]
            );
            return true;
        });
    }

    async recordLoginFailure(userId: string): Promise<void> {
        await this.pool.query(
            `UPDATE security_users
             SET failed_login_attempts = failed_login_attempts + 1,
                 locked_until = CASE
                    WHEN failed_login_attempts + 1 >= 5 THEN clock_timestamp() + interval '15 minutes'
                    ELSE locked_until
                 END,
                 updated_at = clock_timestamp()
             WHERE id = $1`,
            [userId]
        );
    }

    async recordLoginSuccess(userId: string): Promise<void> {
        await this.pool.query(
            `UPDATE security_users
             SET failed_login_attempts = 0, locked_until = NULL,
                 last_login_at = clock_timestamp(), updated_at = clock_timestamp()
             WHERE id = $1`,
            [userId]
        );
    }

    async createSession(input: {
        userId: string;
        tokenHash: Buffer;
        csrfTokenHash: Buffer;
        expiresAt: Date;
        idleExpiresAt: Date;
        ipAddress: string | null;
        userAgent: string | null;
    }): Promise<string> {
        const sessionId = randomUUID();
        await this.pool.query(
            `INSERT INTO security_sessions(
                id, user_id, token_hash, csrf_token_hash, expires_at, idle_expires_at,
                ip_address, user_agent
             ) VALUES ($1, $2, $3, $4, $5, $6, $7::inet, $8)`,
            [
                sessionId, input.userId, input.tokenHash, input.csrfTokenHash,
                input.expiresAt, input.idleExpiresAt, input.ipAddress, input.userAgent
            ]
        );
        return sessionId;
    }

    async authenticateSession(tokenHash: Buffer, idleMs: number): Promise<SessionAuthentication | undefined> {
        const result = await this.pool.query<SessionAuthenticationRow>(
            `UPDATE security_sessions AS session
             SET last_seen_at = clock_timestamp(),
                 idle_expires_at = LEAST(
                    session.expires_at,
                    clock_timestamp() + ($2 * interval '1 millisecond')
                 )
             FROM security_users AS security_user
             WHERE session.token_hash = $1
               AND session.user_id = security_user.id
               AND session.expires_at > clock_timestamp()
               AND session.idle_expires_at > clock_timestamp()
               AND security_user.status = 'active'
             RETURNING security_user.*, session.id AS session_id, session.csrf_token_hash`,
            [tokenHash, idleMs]
        );
        const row = result.rows[0];
        if (row === undefined) return undefined;
        return {
            actor: mapActor(row, 'session', row.session_id),
            sessionId: row.session_id,
            csrfTokenHash: row.csrf_token_hash
        };
    }

    async revokeSession(sessionId: string): Promise<void> {
        await this.pool.query('DELETE FROM security_sessions WHERE id = $1', [sessionId]);
    }

    async revokeUserAccess(userId: string): Promise<void> {
        await withTransaction(this.pool, async client => {
            await client.query('DELETE FROM security_sessions WHERE user_id = $1', [userId]);
            await client.query(
                `UPDATE security_api_tokens SET revoked_at = clock_timestamp()
                 WHERE user_id = $1 AND revoked_at IS NULL`,
                [userId]
            );
        });
    }

    async createApiToken(input: {
        userId: string;
        name: string;
        tokenHash: Buffer;
        expiresAt: Date | null;
    }): Promise<ApiTokenSummary> {
        const result = await this.pool.query<ApiTokenRow>(
            `INSERT INTO security_api_tokens(id, user_id, name, token_hash, expires_at)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING *`,
            [randomUUID(), input.userId, input.name, input.tokenHash, input.expiresAt]
        );
        return mapToken(result.rows[0]!);
    }

    async authenticateApiToken(tokenHash: Buffer): Promise<AuthenticatedActor | undefined> {
        const result = await this.pool.query<TokenAuthenticationRow>(
            `UPDATE security_api_tokens AS token
             SET last_used_at = clock_timestamp()
             FROM security_users AS security_user
             WHERE token.token_hash = $1
               AND token.user_id = security_user.id
               AND token.revoked_at IS NULL
               AND (token.expires_at IS NULL OR token.expires_at > clock_timestamp())
               AND security_user.status = 'active'
             RETURNING security_user.*, token.id AS token_id`,
            [tokenHash]
        );
        const row = result.rows[0];
        return row === undefined ? undefined : mapActor(row, 'api_token', row.token_id);
    }

    async listApiTokens(userId: string): Promise<ApiTokenSummary[]> {
        const result = await this.pool.query<ApiTokenRow>(
            `SELECT id, name, expires_at, last_used_at, revoked_at, created_at
             FROM security_api_tokens WHERE user_id = $1
             ORDER BY created_at DESC, id DESC`,
            [userId]
        );
        return result.rows.map(mapToken);
    }

    async revokeApiToken(userId: string, tokenId: string): Promise<boolean> {
        const result = await this.pool.query(
            `UPDATE security_api_tokens SET revoked_at = clock_timestamp()
             WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
            [tokenId, userId]
        );
        return (result.rowCount ?? 0) > 0;
    }
}

function mapCredential(row: UserRow): UserCredential {
    return {
        ...mapUser(row),
        passwordHash: row.password_hash,
        failedLoginAttempts: row.failed_login_attempts,
        lockedUntil: row.locked_until
    };
}

function mapUser(row: UserRow): SecurityUser {
    return {
        userId: row.id,
        email: row.email,
        displayName: row.display_name,
        role: row.role,
        status: row.status,
        lastLoginAt: row.last_login_at?.toISOString() ?? null,
        passwordChangedAt: row.password_changed_at.toISOString(),
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString()
    };
}

function mapActor(row: UserRow, authType: 'session' | 'api_token', credentialId: string): AuthenticatedActor {
    return {
        userId: row.id,
        email: row.email,
        displayName: row.display_name,
        role: row.role,
        authType,
        credentialId
    };
}

function mapToken(row: ApiTokenRow): ApiTokenSummary {
    return {
        tokenId: row.id,
        name: row.name,
        expiresAt: row.expires_at?.toISOString() ?? null,
        lastUsedAt: row.last_used_at?.toISOString() ?? null,
        revokedAt: row.revoked_at?.toISOString() ?? null,
        createdAt: row.created_at.toISOString()
    };
}
