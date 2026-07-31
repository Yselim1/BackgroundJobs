import type { AppConfig } from '../config.js';
import type { DatabasePool } from '../db/pool.js';
import { AuditRepository } from '../repositories/AuditRepository.js';
import { SecretRepository } from '../repositories/SecretRepository.js';
import { SecurityRepository } from '../repositories/SecurityRepository.js';
import { AuthService } from '../services/AuthService.js';
import { SecretService } from '../services/SecretService.js';

export interface SecurityRuntime {
    auth: AuthService;
    audit: AuditRepository;
    secrets: SecretService;
    config: AppConfig;
}

export function createSecurityRuntime(pool: DatabasePool, config: AppConfig): SecurityRuntime {
    const audit = new AuditRepository(pool);
    return {
        auth: new AuthService(
            new SecurityRepository(pool),
            audit,
            config.authSessionTtlMs,
            config.authSessionIdleMs
        ),
        audit,
        secrets: new SecretService(new SecretRepository(pool), config.secretsMasterKey),
        config
    };
}
