import { createHmac } from 'node:crypto';
import type { ClaimedNotificationDelivery, NotificationRepository } from '../repositories/NotificationRepository.js';
import type { SecretService } from './SecretService.js';

export class NotificationDispatcher {
    private accepting = false;
    private ticking = false;
    private timer: NodeJS.Timeout | undefined;
    constructor(
        private readonly repository: NotificationRepository,
        private readonly secrets: SecretService,
        private readonly options: { pollMs?: number; maxAttempts?: number; requestTimeoutMs?: number; fetchImplementation?: typeof fetch } = {}
    ) {}
    get started(): boolean { return this.accepting; }
    async start(): Promise<void> { if (this.accepting) return; await this.repository.reconcileDelivering(this.options.maxAttempts ?? 5); this.accepting = true; await this.tick(); }
    async shutdown(): Promise<void> { this.accepting = false; if (this.timer !== undefined) clearTimeout(this.timer); }
    async wake(): Promise<void> { if (this.accepting) await this.tick(); }
    private async tick(): Promise<void> {
        if (!this.accepting || this.ticking) return;
        this.ticking = true;
        try {
            const delivery = await this.repository.claimDue();
            if (delivery !== undefined) { await this.deliver(delivery); setImmediate(() => void this.tick()); }
        } catch (error: unknown) { console.error('[NOTIFICATIONS] Poll failed:', error); }
        finally {
            this.ticking = false;
            if (this.accepting && this.timer === undefined) {
                this.timer = setTimeout(() => { this.timer = undefined; void this.tick(); }, this.options.pollMs ?? 500);
                this.timer.unref();
            }
        }
    }
    private async deliver(delivery: ClaimedNotificationDelivery): Promise<void> {
        let responseStatus: number | null = null;
        try {
            const url = await this.secrets.resolve(delivery.endpointSecretName);
            const body = delivery.kind === 'slack'
                ? JSON.stringify({ text: slackText(delivery.payload) })
                : JSON.stringify(delivery.payload);
            const headers: Record<string, string> = { 'Content-Type': 'application/json', 'User-Agent': 'workline-notifications/1.0',
                'X-Workline-Delivery': delivery.deliveryId };
            if (delivery.kind === 'generic_webhook' && delivery.signingSecretName !== null) {
                const timestamp = Math.floor(Date.now() / 1000).toString();
                const key = await this.secrets.resolve(delivery.signingSecretName);
                headers['X-Workline-Timestamp'] = timestamp;
                headers['X-Workline-Signature'] = `sha256=${createHmac('sha256', key).update(`${timestamp}.${body}`).digest('hex')}`;
            }
            const response = await (this.options.fetchImplementation ?? fetch)(url, { method: 'POST', headers, body,
                signal: AbortSignal.timeout(this.options.requestTimeoutMs ?? 10_000) });
            responseStatus = response.status;
            if (!response.ok) throw new Error(`Notification endpoint returned HTTP ${response.status}.`);
            await this.repository.complete(delivery.deliveryId, response.status);
        } catch (error: unknown) {
            await this.repository.fail(delivery.deliveryId, this.options.maxAttempts ?? 5,
                (error instanceof Error ? error.message : String(error)).slice(0, 2000), responseStatus);
        }
    }
}

function slackText(payload: Record<string, unknown>): string {
    const incident = payload.incident as Record<string, unknown> | undefined;
    return `[${String(incident?.severity ?? 'unknown').toUpperCase()}] ${String(incident?.jobId ?? 'Workline')} — ${String(incident?.reason ?? payload.event ?? 'Incident update')}`;
}
