import { Router, type NextFunction, type Request, type Response } from 'express';
import type { AppConfig } from '../config.js';
import { AppError } from '../errors.js';
import {
    clearSessionCookies,
    requestIp,
    requestUserAgent,
    requireAuthentication,
    requirePermission,
    setSessionCookies
} from '../security/middleware.js';
import { AuthService } from '../services/AuthService.js';

export function createAuthController(auth: AuthService, config: AppConfig): Router {
    const router = Router();
    router.use((_req, res, next) => {
        res.setHeader('Cache-Control', 'no-store');
        next();
    });

    router.post('/login', route(async (req, res) => {
        const body = requireBody(req.body);
        const result = await auth.login(body.email, body.password, {
            requestId: req.requestId,
            ipAddress: requestIp(req),
            userAgent: requestUserAgent(req)
        });
        setSessionCookies(res, result.sessionToken, result.csrfToken, config.authCookieSecure);
        res.status(200).json({
            ...auth.me(result.actor),
            csrfToken: result.csrfToken,
            expiresAt: result.expiresAt
        });
    }));

    router.use(requireAuthentication);
    router.get('/me', (req, res) => {
        res.status(200).json(auth.me(req.auth!));
    });
    router.post('/logout', route(async (req, res) => {
        if (req.authSession !== undefined) await auth.logout(req.authSession.sessionId);
        clearSessionCookies(res, config.authCookieSecure);
        res.status(204).send();
    }));
    router.post('/password', route(async (req, res) => {
        const body = requireBody(req.body);
        await auth.changeOwnPassword(req.auth!, body.currentPassword, body.newPassword);
        clearSessionCookies(res, config.authCookieSecure);
        res.status(204).send();
    }));
    router.get('/tokens', requirePermission('tokens:manage_self'), route(async (req, res) => {
        res.status(200).json({ items: await auth.listApiTokens(req.auth!) });
    }));
    router.post('/tokens', requirePermission('tokens:manage_self'), route(async (req, res) => {
        res.status(201).json(await auth.createApiToken(req.auth!, req.body));
    }));
    router.delete('/tokens/:id', requirePermission('tokens:manage_self'), route(async (req, res) => {
        await auth.revokeApiToken(req.auth!, req.params.id as string);
        res.status(204).send();
    }));
    return router;
}

function requireBody(value: unknown): Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new AppError('INVALID_REQUEST_BODY', 'Request body must be an object.', 422);
    }
    return value as Record<string, unknown>;
}

type Handler = (req: Request, res: Response) => Promise<void>;
function route(handler: Handler): (req: Request, res: Response, next: NextFunction) => void {
    return (req, res, next) => { void handler(req, res).catch(next); };
}
