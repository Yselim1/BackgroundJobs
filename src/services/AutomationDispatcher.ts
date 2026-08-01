import type { AutomationRepository } from '../repositories/AutomationRepository.js';

export class AutomationDispatcher {
    private active = false;
    private timer: NodeJS.Timeout | undefined;

    constructor(private readonly automations: AutomationRepository, private readonly pollMs = 250) {}
    get started(): boolean { return this.active; }

    async start(): Promise<void> {
        if (this.active) return;
        this.active = true;
        await this.tick();
    }

    async shutdown(): Promise<void> {
        this.active = false;
        if (this.timer !== undefined) clearTimeout(this.timer);
    }

    private async tick(): Promise<void> {
        if (!this.active) return;
        try {
            while (this.active && await this.automations.dispatchOne()) { /* drain due outbox */ }
        } catch (error: unknown) {
            console.error('[AUTOMATION] Dispatch failed:', error);
        } finally {
            if (this.active) {
                this.timer = setTimeout(() => void this.tick(), this.pollMs);
                this.timer.unref();
            }
        }
    }
}
