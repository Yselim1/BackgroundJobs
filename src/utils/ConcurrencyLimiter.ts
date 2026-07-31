import { abortError, throwIfAborted } from '../errors.js';

interface Waiter {
    signal: AbortSignal;
    resolve: (release: () => void) => void;
    reject: (error: Error) => void;
    onAbort: () => void;
}

export class ConcurrencyLimiter {
    private active = 0;
    private readonly waiters: Waiter[] = [];

    constructor(private readonly limit: number) {
        if (!Number.isInteger(limit) || limit < 1) throw new Error('Concurrency limit must be a positive integer.');
    }

    async run<T>(signal: AbortSignal, task: () => Promise<T>): Promise<T> {
        const release = await this.acquire(signal);
        try {
            return await task();
        } finally {
            release();
        }
    }

    private acquire(signal: AbortSignal): Promise<() => void> {
        throwIfAborted(signal);
        if (this.active < this.limit) {
            this.active++;
            return Promise.resolve(this.releaseOnce());
        }
        return new Promise((resolve, reject) => {
            const waiter: Waiter = {
                signal,
                resolve,
                reject,
                onAbort: () => {
                    const index = this.waiters.indexOf(waiter);
                    if (index >= 0) this.waiters.splice(index, 1);
                    reject(abortError(signal));
                }
            };
            this.waiters.push(waiter);
            signal.addEventListener('abort', waiter.onAbort, { once: true });
        });
    }

    private releaseOnce(): () => void {
        let released = false;
        return () => {
            if (released) return;
            released = true;
            while (this.waiters.length > 0) {
                const waiter = this.waiters.shift()!;
                waiter.signal.removeEventListener('abort', waiter.onAbort);
                if (waiter.signal.aborted) {
                    waiter.reject(abortError(waiter.signal));
                    continue;
                }
                waiter.resolve(this.releaseOnce());
                return;
            }
            this.active--;
        };
    }
}
