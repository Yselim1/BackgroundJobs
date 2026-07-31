import type { SecurityRole } from '../types/index.js';

export type Permission =
    | 'jobs:read'
    | 'jobs:run'
    | 'jobs:write'
    | 'executions:read'
    | 'executions:cancel'
    | 'platform:read'
    | 'tokens:manage_self'
    | 'users:manage'
    | 'secrets:manage'
    | 'audit:read';

const ROLE_PERMISSIONS: Record<SecurityRole, ReadonlySet<Permission>> = {
    viewer: new Set(['jobs:read', 'executions:read', 'platform:read', 'tokens:manage_self']),
    operator: new Set([
        'jobs:read', 'jobs:run', 'executions:read', 'executions:cancel',
        'platform:read', 'tokens:manage_self'
    ]),
    admin: new Set([
        'jobs:read', 'jobs:run', 'jobs:write', 'executions:read', 'executions:cancel',
        'platform:read', 'tokens:manage_self', 'users:manage', 'secrets:manage', 'audit:read'
    ])
};

export function hasPermission(role: SecurityRole, permission: Permission): boolean {
    return ROLE_PERMISSIONS[role].has(permission);
}

export function permissionsForRole(role: SecurityRole): Permission[] {
    return [...ROLE_PERMISSIONS[role]];
}
