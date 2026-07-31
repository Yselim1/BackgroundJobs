import { Router, type NextFunction, type Request, type Response } from 'express';
import { AppError } from '../errors.js';
import { AuditRepository } from '../repositories/AuditRepository.js';
import { requirePermission } from '../security/middleware.js';
import { AuthService } from '../services/AuthService.js';
import { SecretService } from '../services/SecretService.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function createSecurityController(
    auth: AuthService,
    secrets: SecretService,
    audit: AuditRepository
): Router {
    const router = Router();
    router.use((_req, res, next) => {
        res.setHeader('Cache-Control', 'no-store');
        next();
    });

    router.get('/users', requirePermission('users:manage'), route(async (_req, res) => {
        res.status(200).json({ items: await auth.listUsers() });
    }));
    router.post('/users', requirePermission('users:manage'), route(async (req, res) => {
        res.status(201).json(await auth.createUser(req.body));
    }));
    router.patch('/users/:id', requirePermission('users:manage'), route(async (req, res) => {
        res.status(200).json(await auth.updateUser(req.params.id as string, req.body));
    }));
    router.post('/users/:id/password', requirePermission('users:manage'), route(async (req, res) => {
        const body = requireBody(req.body);
        await auth.resetPassword(req.params.id as string, body.password);
        res.status(204).send();
    }));

    router.get('/secrets', requirePermission('secrets:manage'), route(async (_req, res) => {
        res.status(200).json({ configured: secrets.configured, items: await secrets.list() });
    }));
    router.put('/secrets/:name', requirePermission('secrets:manage'), route(async (req, res) => {
        const body = requireBody(req.body);
        res.status(200).json(await secrets.put(
            req.params.name,
            body.value,
            body.description,
            req.auth!.userId
        ));
    }));
    router.delete('/secrets/:name', requirePermission('secrets:manage'), route(async (req, res) => {
        await secrets.delete(req.params.name);
        res.status(204).send();
    }));

    router.get('/audit', requirePermission('audit:read'), route(async (req, res) => {
        const limit = parseLimit(req.query.limit);
        const cursor = parseOptionalString(req.query.cursor, 'cursor');
        const action = parseOptionalString(req.query.action, 'action');
        const actorUserId = parseOptionalString(req.query.actorUserId, 'actorUserId');
        if (actorUserId !== undefined && !UUID.test(actorUserId)) {
            throw new AppError('INVALID_ACTOR_USER_ID', 'actorUserId must be a UUID.', 400);
        }
        const outcome = parseOptionalString(req.query.outcome, 'outcome');
        if (outcome !== undefined && outcome !== 'success' && outcome !== 'failure') {
            throw new AppError('INVALID_AUDIT_OUTCOME', 'outcome must be success or failure.', 400);
        }
        res.status(200).json(await audit.list({
            limit,
            ...(cursor === undefined ? {} : { cursor }),
            ...(action === undefined ? {} : { action }),
            ...(actorUserId === undefined ? {} : { actorUserId }),
            ...(outcome === undefined ? {} : { outcome })
        }));
    }));
    return router;
}

function parseLimit(value: unknown): number {
    if (value === undefined) return 50;
    if (typeof value !== 'string' || !/^\d+$/u.test(value)) {
        throw new AppError('INVALID_LIMIT', 'limit must be an integer.', 400);
    }
    const parsed = Number(value);
    if (parsed < 1 || parsed > 200) throw new AppError('INVALID_LIMIT', 'limit must be between 1 and 200.', 400);
    return parsed;
}

function parseOptionalString(value: unknown, name: string): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || value.length === 0) {
        throw new AppError('INVALID_' + name.toUpperCase(), name + ' must be a non-empty string.', 400);
    }
    return value;
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
