export type DashboardRoute =
    | { page: 'overview' }
    | { page: 'jobs' }
    | { page: 'job-detail'; jobId: string }
    | { page: 'logs'; executionId?: string }
    | { page: 'audit' }
    | { page: 'attention' }
    | { page: 'workers' }
    | { page: 'admin' };

export function parseDashboardRoute(pathname: string): DashboardRoute {
    const segments = (pathname || '/').split('/').filter(Boolean).map(safeDecode);
    if (segments[0] === 'jobs' && segments[1] !== undefined) {
        return { page: 'job-detail', jobId: segments[1] };
    }
    if (segments[0] === 'jobs') return { page: 'jobs' };
    if (segments[0] === 'logs') {
        return { page: 'logs', ...(segments[1] === undefined ? {} : { executionId: segments[1] }) };
    }
    if (segments[0] === 'audit') return { page: 'audit' };
    if (segments[0] === 'attention') return { page: 'attention' };
    if (segments[0] === 'workers') return { page: 'workers' };
    if (segments[0] === 'admin') return { page: 'admin' };
    return { page: 'overview' };
}

export function routeSearchParams(search = window.location.search): URLSearchParams {
    return new URLSearchParams(search);
}

export function setRouteQuery(path: string, values: Record<string, string | undefined>): void {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(values)) {
        if (value !== undefined && value.length > 0 && value !== 'all') query.set(key, value);
    }
    const suffix = query.toString();
    const next = path + (suffix.length === 0 ? '' : '?' + suffix);
    window.history.replaceState(null, '', next);
}

export function navigate(path: string, replace = false): void {
    if (replace) window.history.replaceState(null, '', path);
    else window.history.pushState(null, '', path);
    window.dispatchEvent(new PopStateEvent('popstate'));
}

function safeDecode(value: string): string {
    try { return decodeURIComponent(value); }
    catch { return value; }
}
