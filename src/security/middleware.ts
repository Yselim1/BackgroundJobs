import { randomUUID, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { AppConfig } from '../config.js';
import { AppError } from '../errors.js';
import { AuditRepository } from '../repositories/AuditRepository.js';
import { AuthService, hashToken } from '../services/AuthService.js';
import type { Permission } from './permissions.js';
import { hasPermission } from './permissions.js';
import './request.js';

export const SESSION_COOKIE = 'bj_session';
export const CSRF_COOKIE = 'bj_csrf';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function requestSecurity(config: AppConfig): RequestHandler {
    const allowedOrigins = new Set(config.corsAllowedOrigins);
    return (req, res, next) => {
        const suppliedRequestId = req.get('X-Request-ID');
        req.requestId = suppliedRequestId !== undefined && UUID.test(suppliedRequestId)
            ? suppliedRequestId
            : randomUUID();
        res.setHeader('X-Request-ID', req.requestId);
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-Frame-Options', 'DENY');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
        res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
        res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");

        const origin = req.get('Origin');
        if (origin !== undefined) {
            if (!allowedOrigins.has(origin)) {
                next(new AppError('ORIGIN_NOT_ALLOWED', 'Request origin is not allowed.', 403));
                return;
            }
            res.setHeader('Access-Control-Allow-Origin', origin);
            res.setHeader('Access-Control-Allow-Credentials', 'true');
            res.appendHeader('Vary', 'Origin');
        }
        if (req.method === 'OPTIONS') {
            if (origin === undefined) {
                next(new AppError('ORIGIN_REQUIRED', 'CORS preflight requires an Origin header.', 403));
                return;
            }
            res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,POST,PUT,PATCH,DELETE');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-CSRF-Token,X-Request-ID,Last-Event-ID');
            res.status(204).send();
            return;
        }
        next();
    };
}

export function identifyRequest(auth: AuthService): RequestHandler {
    return async (req, _res, next) => {
        try {
            const authorization = req.get('Authorization');
            if (authorization !== undefined) {
                const match = /^Bearer ([^\s]+)$/u.exec(authorization);
                if (match === null) throw new AppError('INVALID_AUTHORIZATION', 'Authorization must use a Bearer token.', 401);
                const actor = await auth.authenticateApiToken(match[1] as string);
                if (actor === undefined) throw new AppError('INVALID_API_TOKEN', 'API token is invalid or expired.', 401);
                req.auth = actor;
                next();
                return;
            }
            const sessionToken = parseCookies(req)[SESSION_COOKIE];
            if (sessionToken !== undefined) {
                const session = await auth.authenticateSession(sessionToken);
                if (session !== undefined) {
                    req.auth = session.actor;
                    req.authSession = {
                        sessionId: session.sessionId,
                        csrfTokenHash: session.csrfTokenHash
                    };
                }
            }
            next();
        } catch (error: unknown) {
            next(error);
        }
    };
}

export function requireAuthentication(req: Request, _res: Response, next: NextFunction): void {
    if (req.auth === undefined) {
        next(new AppError('AUTHENTICATION_REQUIRED', 'Authentication is required.', 401));
        return;
    }
    next();
}

export function requirePasswordChangeComplete(req: Request, _res: Response, next: NextFunction): void {
    if (req.auth?.passwordChangeRequired === true) {
        next(new AppError(
            'PASSWORD_CHANGE_REQUIRED',
            'You must change your temporary password before using the application.',
            403
        ));
        return;
    }
    next();
}

export function requirePermission(permission: Permission): RequestHandler {
    return (req, _res, next) => {
        if (req.auth === undefined) {
            next(new AppError('AUTHENTICATION_REQUIRED', 'Authentication is required.', 401));
            return;
        }
        if (!hasPermission(req.auth.role, permission)) {
            next(new AppError('PERMISSION_DENIED', 'Your role does not permit this operation.', 403));
            return;
        }
        next();
    };
}

export function protectCsrf(req: Request, _res: Response, next: NextFunction): void {
    if (SAFE_METHODS.has(req.method) || req.authSession === undefined) {
        next();
        return;
    }
    const headerToken = req.get('X-CSRF-Token');
    const cookieToken = parseCookies(req)[CSRF_COOKIE];
    if (headerToken === undefined || cookieToken === undefined ||
        headerToken.length > 256 || headerToken !== cookieToken) {
        next(new AppError('CSRF_TOKEN_INVALID', 'A valid CSRF token is required.', 403));
        return;
    }
    const actual = hashToken(headerToken);
    const expected = req.authSession.csrfTokenHash;
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        next(new AppError('CSRF_TOKEN_INVALID', 'A valid CSRF token is required.', 403));
        return;
    }
    next();
}

export function auditMutations(audit: AuditRepository): RequestHandler {
    return (req, res, next) => {
        const descriptor = describeMutation(req);
        if (descriptor !== undefined) {
            res.once('finish', () => {
                void audit.record({
                    requestId: req.requestId,
                    ...(req.auth === undefined ? {} : { actor: req.auth }),
                    action: descriptor.action,
                    outcome: res.statusCode < 400 ? 'success' : 'failure',
                    statusCode: res.statusCode,
                    ...(descriptor.resourceType === undefined ? {} : { resourceType: descriptor.resourceType }),
                    ...(descriptor.resourceId === undefined ? {} : { resourceId: descriptor.resourceId }),
                    ipAddress: requestIp(req),
                    userAgent: requestUserAgent(req)
                }).catch(error => console.error('[AUDIT] Failed to persist request audit event:', error));
            });
        }
        next();
    };
}

export function setSessionCookies(
    res: Response,
    sessionToken: string,
    csrfToken: string,
    secure: boolean
): void {
    const common = { secure, sameSite: 'strict' as const, path: '/' };
    res.cookie(SESSION_COOKIE, sessionToken, { ...common, httpOnly: true });
    res.cookie(CSRF_COOKIE, csrfToken, { ...common, httpOnly: false });
}

export function clearSessionCookies(res: Response, secure: boolean): void {
    const common = { secure, sameSite: 'strict' as const, path: '/' };
    res.clearCookie(SESSION_COOKIE, { ...common, httpOnly: true });
    res.clearCookie(CSRF_COOKIE, { ...common, httpOnly: false });
}

export function requestIp(req: Request): string | null {
    const value = req.ip?.replace(/^::ffff:/u, '');
    return value !== undefined && isIP(value) !== 0 ? value : null;
}

export function requestUserAgent(req: Request): string | null {
    return req.get('User-Agent')?.slice(0, 1_000) ?? null;
}

function parseCookies(req: Request): Record<string, string> {
    const header = req.get('Cookie');
    if (header === undefined) return {};
    const cookies: Record<string, string> = {};
    for (const item of header.split(';')) {
        const separator = item.indexOf('=');
        if (separator < 1) continue;
        const name = item.slice(0, separator).trim();
        const value = item.slice(separator + 1).trim();
        try { cookies[name] = decodeURIComponent(value); }
        catch { continue; }
    }
    return cookies;
}

function describeMutation(req: Request): {
    action: string;
    resourceType?: string;
    resourceId?: string;
} | undefined {
    const path = req.originalUrl.split('?', 1)[0] ?? req.path;
    if (SAFE_METHODS.has(req.method) || path === '/api/auth/login') return undefined;
    const mappings: Array<[RegExp, string, string?]> = [
        [/^\/api\/jobs\/validate$/u, 'job.validate', 'job'],
        [/^\/api\/jobs\/schedule-preview$/u, 'job.schedule_preview', 'job'],
        [/^\/api\/jobs\/bulk-status$/u, 'job.bulk_status', 'job'],
        [/^\/api\/jobs\/([^/]+)\/run$/u, 'execution.queue', 'job'],
        [/^\/api\/jobs\/([^/]+)$/u, req.method === 'DELETE' ? 'job.delete' : 'job.replace', 'job'],
        [/^\/api\/jobs$/u, 'job.create', 'job'],
        [/^\/api\/executions\/([^/]+)\/cancel$/u, 'execution.cancel', 'execution'],
        [/^\/api\/attention\/([^/]+)\/ignore$/u, 'attention.ignore', 'attention'],
        [/^\/api\/attention\/([^/]+)\/restore$/u, 'attention.restore', 'attention'],
        [/^\/api\/attention\/([^/]+)\/rerun$/u, 'attention.rerun', 'attention'],
        [/^\/api\/attention\/([^/]+)\/retry-webhook$/u, 'attention.webhook_retry', 'attention'],
        [/^\/api\/auth\/logout$/u, 'auth.logout'],
        [/^\/api\/auth\/password$/u, 'auth.password_change', 'user'],
        [/^\/api\/auth\/tokens\/([^/]+)$/u, 'api_token.revoke', 'api_token'],
        [/^\/api\/auth\/tokens$/u, 'api_token.create', 'api_token'],
        [/^\/api\/security\/users\/([^/]+)\/password$/u, 'user.password_reset', 'user'],
        [/^\/api\/security\/users\/([^/]+)\/unlock$/u, 'user.unlock', 'user'],
        [/^\/api\/security\/users\/([^/]+)\/revoke-access$/u, 'user.access_revoke', 'user'],
        [/^\/api\/security\/users\/([^/]+)\/sessions\/[^/]+$/u, 'user.session_revoke', 'user'],
        [/^\/api\/security\/users\/([^/]+)\/tokens\/[^/]+$/u, 'user.token_revoke', 'user'],
        [/^\/api\/security\/users\/([^/]+)$/u, 'user.update', 'user'],
        [/^\/api\/security\/users$/u, 'user.create', 'user'],
        [/^\/api\/security\/secrets\/([^/]+)$/u, req.method === 'DELETE' ? 'secret.delete' : 'secret.upsert', 'secret']
    ];
    for (const [pattern, action, resourceType] of mappings) {
        const match = pattern.exec(path);
        if (match !== null) {
            return {
                action,
                ...(resourceType === undefined ? {} : { resourceType }),
                ...(match[1] === undefined ? {} : { resourceId: decodeURIComponent(match[1]) })
            };
        }
    }
    return { action: 'api.mutation', resourceType: 'endpoint', resourceId: path };
}
