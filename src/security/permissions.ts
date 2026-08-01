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
    | 'audit:read'
    | 'attention:read'
    | 'attention:manage'
    | 'system:read'
    | 'workers:manage';

const ROLE_PERMISSIONS: Record<SecurityRole, ReadonlySet<Permission>> = {
    viewer: new Set(['jobs:read', 'executions:read', 'platform:read', 'tokens:manage_self', 'attention:read']),
    operator: new Set([
        'jobs:read', 'jobs:run', 'executions:read', 'executions:cancel',
        'platform:read', 'tokens:manage_self', 'attention:read'
    ]),
    admin: new Set([
        'jobs:read', 'jobs:run', 'jobs:write', 'executions:read', 'executions:cancel',
        'platform:read', 'tokens:manage_self', 'users:manage', 'secrets:manage', 'audit:read',
        'attention:read', 'attention:manage', 'system:read', 'workers:manage'
    ])
};

export function hasPermission(role: SecurityRole, permission: Permission): boolean {
    return ROLE_PERMISSIONS[role].has(permission);
}

export function permissionsForRole(role: SecurityRole): Permission[] {
    return [...ROLE_PERMISSIONS[role]];
}
