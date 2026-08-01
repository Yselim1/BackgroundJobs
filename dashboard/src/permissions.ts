export function dashboardNavigation(permissions: string[]): {
    attention: boolean;
    administration: boolean;
    audit: boolean;
} {
    return {
        attention: permissions.includes('attention:read'),
        administration: permissions.includes('users:manage') || permissions.includes('secrets:manage') || permissions.includes('system:read'),
        audit: permissions.includes('audit:read')
    };
}
