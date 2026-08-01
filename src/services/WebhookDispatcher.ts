import { createHmac } from 'node:crypto';
import type { ClaimedWebhookDelivery, WebhookRepository } from '../repositories/WebhookRepository.js';
import type { SecretService } from './SecretService.js';

export interface WebhookDispatcherOptions {
    concurrency?: number;
    pollMs?: number;
    maxAttempts?: number;
    requestTimeoutMs?: number;
    signingKey?: string;
    fetchImplementation?: typeof fetch;
    secrets?: SecretService;
}

export class WebhookDispatcher {
    private acceptingWork = false;
    private servicesStarted = false;
    private ticking = false;
    private timer: NodeJS.Timeout | undefined;
    private readonly active = new Map<string, Promise<void>>();
    private readonly concurrency: number;
    private readonly pollMs: number;
    private readonly maxAttempts: number;
    private readonly requestTimeoutMs: number;
    private readonly signingKey: string | undefined;
    private readonly fetchImplementation: typeof fetch;
    private readonly secrets: SecretService | undefined;

    constructor(private readonly deliveries: WebhookRepository, options: WebhookDispatcherOptions = {}) {
        this.concurrency = options.concurrency ?? 2;
        this.pollMs = options.pollMs ?? 500;
        this.maxAttempts = options.maxAttempts ?? 5;
        this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
        this.signingKey = options.signingKey;
        this.fetchImplementation = options.fetchImplementation ?? fetch;
        this.secrets = options.secrets;
    }

    get started(): boolean { return this.servicesStarted; }

    async wake(): Promise<void> {
        if (!this.acceptingWork) return;
        await this.tick();
    }

    async start(): Promise<void> {
        if (this.acceptingWork) return;
        await this.deliveries.reconcileDelivering(this.maxAttempts);
        this.acceptingWork = true;
        this.servicesStarted = true;
        await this.tick();
    }

    async shutdown(): Promise<void> {
        this.acceptingWork = false;
        this.servicesStarted = false;
        if (this.timer !== undefined) clearTimeout(this.timer);
        await Promise.allSettled([...this.active.values()]);
    }

    private async tick(): Promise<void> {
        if (!this.acceptingWork || this.ticking) return;
        this.ticking = true;
        try {
            while (this.acceptingWork && this.active.size < this.concurrency) {
                const delivery = await this.deliveries.claimDue();
                if (delivery === undefined) break;
                const work = this.deliver(delivery).finally(() => {
                    this.active.delete(delivery.deliveryId);
                    if (this.acceptingWork) setImmediate(() => void this.tick());
                });
                this.active.set(delivery.deliveryId, work);
            }
        } catch (error: unknown) {
            console.error('[WEBHOOKS] Poll failed:', error);
        } finally {
            this.ticking = false;
            if (this.acceptingWork && this.timer === undefined) {
                this.timer = setTimeout(() => {
                    this.timer = undefined;
                    void this.tick();
                }, this.pollMs);
                this.timer.unref();
            }
        }
    }

    private async deliver(delivery: ClaimedWebhookDelivery): Promise<void> {
        const body = JSON.stringify(delivery.payload);
        const timestamp = Math.floor(Date.now() / 1000).toString();
        let responseStatus: number | null = null;
        try {
            const signingKey = delivery.signingSecretName === null
                ? this.signingKey
                : await this.resolveSigningSecret(delivery.signingSecretName);
            const headers: Record<string, string> = {
                'Content-Type': 'application/json',
                'User-Agent': 'backgroundjobs-framework-webhook/1.0',
                'X-Backgroundjobs-Delivery': delivery.deliveryId,
                'X-Backgroundjobs-Event': delivery.eventType,
                'X-Backgroundjobs-Timestamp': timestamp
            };
            if (signingKey !== undefined) {
                headers['X-Backgroundjobs-Signature'] = createWebhookSignature(signingKey, timestamp, body);
            }
            const response = await this.fetchImplementation(delivery.url, {
                method: 'POST',
                headers,
                body,
                signal: AbortSignal.timeout(this.requestTimeoutMs)
            });
            responseStatus = response.status;
            if (!response.ok) {
                const responseBody = (await response.text()).slice(0, 500);
                throw new Error(`Webhook returned HTTP ${response.status}${responseBody.length === 0 ? '' : `: ${responseBody}`}`);
            }
            await this.deliveries.complete(delivery.deliveryId, response.status);
        } catch (error: unknown) {
            const message = (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
            await this.deliveries.fail(delivery.deliveryId, this.maxAttempts, message, responseStatus);
        }
    }

    private async resolveSigningSecret(name: string): Promise<string> {
        if (this.secrets === undefined) {
            throw new Error('Webhook references managed signing secret ' + name + ', but secret resolution is unavailable.');
        }
        return this.secrets.resolve(name);
    }
}

export function createWebhookSignature(signingKey: string, timestamp: string, body: string): string {
    return `sha256=${createHmac('sha256', signingKey).update(`${timestamp}.${body}`).digest('hex')}`;
}
