import type { AuthenticatedActor } from '../types/index.js';

export interface AuthenticatedSession {
    sessionId: string;
    csrfTokenHash: Buffer;
}

declare module 'express-serve-static-core' {
    interface Request {
        auth?: AuthenticatedActor;
        authSession?: AuthenticatedSession;
        requestId: string;
    }
}

export {};
