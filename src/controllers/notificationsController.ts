import { Router, type NextFunction, type Request, type Response } from 'express';
import { AppError } from '../errors.js';
import type { NotificationRepository } from '../repositories/NotificationRepository.js';
import { requirePermission } from '../security/middleware.js';
import type { NotificationDispatcher } from '../services/NotificationDispatcher.js';
import type { AttentionKind, AttentionSeverity, NotificationChannelKind, NotificationPolicy } from '../types/index.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SECRET = /^[A-Z][A-Z0-9_]{1,63}$/u;
const KINDS = new Set<AttentionKind>(['execution_failure', 'webhook_failure']);
const SEVERITIES = new Set<AttentionSeverity>(['critical', 'high', 'medium', 'low']);
const EVENTS = new Set(['opened', 'reopened', 'severity_increased', 'resolved']);

export function createNotificationsController(repository: NotificationRepository, dispatcher?: NotificationDispatcher): Router {
    const router = Router();
    router.use(requirePermission('workers:manage'));
    router.get('/channels', route(async (_req, res) => { res.status(200).json({ items: await repository.listChannels() }); }));
    router.post('/channels', route(async (req, res) => { res.status(201).json(await repository.createChannel(parseChannel(req.body), req.auth!)); }));
    router.patch('/channels/:id', route(async (req, res) => {
        res.status(200).json(await repository.updateChannel(parseUuid(req.params.id), parseChannelPatch(req.body), parseVersion(req.get('If-Match'))));
    }));
    router.get('/policies', route(async (_req, res) => { res.status(200).json({ items: await repository.listPolicies() }); }));
    router.post('/policies', route(async (req, res) => { res.status(201).json(await repository.createPolicy(parsePolicy(req.body), req.auth!)); }));
    router.patch('/policies/:id', route(async (req, res) => {
        res.status(200).json(await repository.updatePolicy(parseUuid(req.params.id), parsePolicyPatch(req.body), parseVersion(req.get('If-Match'))));
    }));
    router.get('/deliveries', route(async (req, res) => {
        const limit = req.query.limit === undefined ? 100 : Number(req.query.limit);
        if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new AppError('INVALID_LIMIT', 'limit must be between 1 and 500.', 400);
        res.status(200).json({ items: await repository.listDeliveries(limit) });
    }));
    router.post('/deliveries/:id/retry', route(async (req, res) => {
        const delivery = await repository.retry(parseUuid(req.params.id));
        await dispatcher?.wake();
        res.status(200).json(delivery);
    }));
    return router;
}

function parseChannel(body: unknown): { name: string; kind: NotificationChannelKind; endpointSecretName: string; signingSecretName: string | null; enabled: boolean } {
    const value = record(body, 'notification channel');
    const name = shortString(value.name, 'name');
    if (value.kind !== 'generic_webhook' && value.kind !== 'slack') throw new AppError('INVALID_NOTIFICATION_CHANNEL', 'kind must be generic_webhook or slack.', 422);
    const endpointSecretName = secretName(value.endpointSecretName, 'endpointSecretName');
    const signingSecretName = value.signingSecretName === undefined || value.signingSecretName === null ? null : secretName(value.signingSecretName, 'signingSecretName');
    if (value.kind === 'generic_webhook' && signingSecretName === null) throw new AppError('INVALID_NOTIFICATION_CHANNEL', 'Generic webhooks require signingSecretName.', 422);
    if (value.enabled !== undefined && typeof value.enabled !== 'boolean') throw new AppError('INVALID_NOTIFICATION_CHANNEL', 'enabled must be a boolean.', 422);
    return { name, kind: value.kind, endpointSecretName, signingSecretName, enabled: value.enabled ?? true };
}
function parseChannelPatch(body: unknown): Partial<{ name: string; endpointSecretName: string; signingSecretName: string | null; enabled: boolean }> {
    const value = record(body, 'notification channel patch');
    return { ...(value.name === undefined ? {} : { name: shortString(value.name, 'name') }),
        ...(value.endpointSecretName === undefined ? {} : { endpointSecretName: secretName(value.endpointSecretName, 'endpointSecretName') }),
        ...(value.signingSecretName === undefined ? {} : { signingSecretName: value.signingSecretName === null ? null : secretName(value.signingSecretName, 'signingSecretName') }),
        ...(value.enabled === undefined ? {} : { enabled: booleanValue(value.enabled, 'enabled') }) };
}
function parsePolicy(body: unknown): Omit<NotificationPolicy, 'policyId' | 'version' | 'createdAt' | 'updatedAt'> {
    const value = record(body, 'notification policy');
    const channelId = parseUuid(value.channelId);
    const incidentKinds = stringArray(value.incidentKinds ?? ['execution_failure', 'webhook_failure'], 'incidentKinds');
    if (!incidentKinds.every(item => KINDS.has(item as AttentionKind))) throw new AppError('INVALID_NOTIFICATION_POLICY', 'incidentKinds contains an invalid kind.', 422);
    const minimumSeverity = value.minimumSeverity ?? 'high';
    if (!SEVERITIES.has(minimumSeverity as AttentionSeverity)) throw new AppError('INVALID_NOTIFICATION_POLICY', 'minimumSeverity is invalid.', 422);
    const lifecycleEvents = stringArray(value.lifecycleEvents ?? ['opened', 'reopened', 'severity_increased', 'resolved'], 'lifecycleEvents');
    if (!lifecycleEvents.every(item => EVENTS.has(item))) throw new AppError('INVALID_NOTIFICATION_POLICY', 'lifecycleEvents contains an invalid event.', 422);
    const jobIds = value.jobIds === undefined || value.jobIds === null ? null : stringArray(value.jobIds, 'jobIds');
    return { name: shortString(value.name, 'name'), channelId, enabled: value.enabled === undefined ? true : booleanValue(value.enabled, 'enabled'),
        incidentKinds: incidentKinds as AttentionKind[], minimumSeverity: minimumSeverity as AttentionSeverity, jobIds,
        lifecycleEvents: lifecycleEvents as NotificationPolicy['lifecycleEvents'] };
}
function parsePolicyPatch(body: unknown): Partial<Omit<NotificationPolicy, 'policyId' | 'version' | 'createdAt' | 'updatedAt'>> {
    const value = record(body, 'notification policy patch');
    const incidentKinds = value.incidentKinds === undefined ? undefined : stringArray(value.incidentKinds, 'incidentKinds');
    if (incidentKinds !== undefined && !incidentKinds.every(item => KINDS.has(item as AttentionKind))) {
        throw new AppError('INVALID_NOTIFICATION_POLICY', 'incidentKinds contains an invalid kind.', 422);
    }
    if (value.minimumSeverity !== undefined && !SEVERITIES.has(value.minimumSeverity as AttentionSeverity)) {
        throw new AppError('INVALID_NOTIFICATION_POLICY', 'minimumSeverity is invalid.', 422);
    }
    const lifecycleEvents = value.lifecycleEvents === undefined ? undefined : stringArray(value.lifecycleEvents, 'lifecycleEvents');
    if (lifecycleEvents !== undefined && !lifecycleEvents.every(item => EVENTS.has(item))) {
        throw new AppError('INVALID_NOTIFICATION_POLICY', 'lifecycleEvents contains an invalid event.', 422);
    }
    return { ...(value.name === undefined ? {} : { name: shortString(value.name, 'name') }),
        ...(value.channelId === undefined ? {} : { channelId: parseUuid(value.channelId) }),
        ...(value.enabled === undefined ? {} : { enabled: booleanValue(value.enabled, 'enabled') }),
        ...(incidentKinds === undefined ? {} : { incidentKinds: incidentKinds as AttentionKind[] }),
        ...(value.minimumSeverity === undefined ? {} : { minimumSeverity: value.minimumSeverity as AttentionSeverity }),
        ...(value.jobIds === undefined ? {} : { jobIds: value.jobIds === null ? null : stringArray(value.jobIds, 'jobIds') }),
        ...(lifecycleEvents === undefined ? {} : { lifecycleEvents: lifecycleEvents as NotificationPolicy['lifecycleEvents'] }) };
}
function record(value: unknown, name: string): Record<string, unknown> { if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new AppError('INVALID_NOTIFICATION_REQUEST', `${name} must be an object.`, 422); return value as Record<string, unknown>; }
function parseUuid(value: unknown): string { if (typeof value !== 'string' || !UUID.test(value)) throw new AppError('INVALID_ID', 'ID must be a UUID.', 400); return value; }
function parseVersion(value: string | undefined): number { if (value === undefined) throw new AppError('VERSION_REQUIRED', 'If-Match is required.', 428); const parsed = Number(value.replace(/^W\//u, '').replace(/^"|"$/gu, '')); if (!Number.isInteger(parsed) || parsed < 1) throw new AppError('INVALID_VERSION', 'If-Match must contain a positive version.', 400); return parsed; }
function shortString(value: unknown, name: string): string { if (typeof value !== 'string' || value.trim().length < 1 || value.length > 100) throw new AppError('INVALID_NOTIFICATION_REQUEST', `${name} must contain between 1 and 100 characters.`, 422); return value.trim(); }
function secretName(value: unknown, name: string): string { if (typeof value !== 'string' || !SECRET.test(value)) throw new AppError('INVALID_NOTIFICATION_REQUEST', `${name} must be a managed-secret name.`, 422); return value; }
function booleanValue(value: unknown, name: string): boolean { if (typeof value !== 'boolean') throw new AppError('INVALID_NOTIFICATION_REQUEST', `${name} must be a boolean.`, 422); return value; }
function stringArray(value: unknown, name: string): string[] { if (!Array.isArray(value) || value.length < 1 || value.some(item => typeof item !== 'string' || item.length === 0)) throw new AppError('INVALID_NOTIFICATION_REQUEST', `${name} must be a non-empty string array.`, 422); return [...new Set(value as string[])]; }
type Handler = (req: Request, res: Response) => Promise<void>;
function route(handler: Handler): (req: Request, res: Response, next: NextFunction) => void { return (req, res, next) => { void handler(req, res).catch(next); }; }
