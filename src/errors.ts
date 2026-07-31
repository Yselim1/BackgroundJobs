export class AppError extends Error {
    constructor(
        readonly code: string,
        message: string,
        readonly statusCode = 500,
        readonly details?: unknown
    ) {
        super(message);
        this.name = 'AppError';
    }
}

export class ExecutionAbortError extends Error {
    constructor(readonly code: 'EXECUTION_CANCELLED' | 'JOB_TIMEOUT' | 'SERVER_INTERRUPTED', message: string) {
        super(message);
        this.name = 'ExecutionAbortError';
    }
}

export function abortError(signal: AbortSignal): ExecutionAbortError {
    if (signal.reason instanceof ExecutionAbortError) return signal.reason;
    return new ExecutionAbortError('EXECUTION_CANCELLED', 'Execution was cancelled.');
}

export function throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) throw abortError(signal);
}

export function toError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}

