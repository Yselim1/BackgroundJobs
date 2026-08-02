const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const DEFAULT_MAX_REDIRECTS = 5;

export async function fetchSameOrigin(
    rawUrl: string | URL,
    init: RequestInit,
    fetchImplementation: typeof fetch = fetch,
    allowedOrigin?: string,
    maxRedirects = DEFAULT_MAX_REDIRECTS
): Promise<Response> {
    let current = httpUrl(rawUrl);
    const origin = allowedOrigin ?? current.origin;
    if (current.origin !== origin) throw new Error(`Outbound URL origin must remain ${origin}.`);
    let request: RequestInit = { ...init, redirect: 'manual' };
    for (let redirectCount = 0; ; redirectCount++) {
        const response = await fetchImplementation(current, request);
        if (!REDIRECT_STATUSES.has(response.status)) return response;
        const location = response.headers.get('location');
        if (location === null) return response;
        await response.body?.cancel().catch(() => undefined);
        if (redirectCount >= maxRedirects) throw new Error(`Outbound request exceeded ${maxRedirects} redirects.`);
        const next = httpUrl(new URL(location, current));
        if (next.origin !== origin) throw new Error(`Outbound redirect changed origin from ${origin} to ${next.origin}.`);
        request = redirectRequest(response.status, request);
        current = next;
    }
}

export async function readResponseText(response: Response, maxBytes: number): Promise<string> {
    const declared = contentLength(response);
    if (declared !== null && declared > maxBytes) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(`Response body exceeded the ${maxBytes} byte limit.`);
    }
    if (response.body === null) return '';
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let total = 0;
    let text = '';
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > maxBytes) {
                await reader.cancel().catch(() => undefined);
                throw new Error(`Response body exceeded the ${maxBytes} byte limit.`);
            }
            text += decoder.decode(value, { stream: true });
        }
        return text + decoder.decode();
    } finally {
        reader.releaseLock();
    }
}

export async function readResponsePrefix(response: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
    if (response.body === null) return { text: '', truncated: false };
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let total = 0;
    let text = '';
    let truncated = false;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            const remaining = maxBytes - total;
            if (value.byteLength > remaining) {
                if (remaining > 0) text += decoder.decode(value.subarray(0, remaining), { stream: true });
                truncated = true;
                await reader.cancel().catch(() => undefined);
                break;
            }
            total += value.byteLength;
            text += decoder.decode(value, { stream: true });
            if (total === maxBytes) {
                const next = await reader.read();
                if (!next.done) {
                    truncated = true;
                    await reader.cancel().catch(() => undefined);
                }
                break;
            }
        }
        return { text: text + decoder.decode(), truncated };
    } finally {
        reader.releaseLock();
    }
}

export function httpUrl(rawUrl: string | URL): URL {
    const parsed = new URL(rawUrl);
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.hostname.length === 0) {
        throw new Error('Outbound URL must use http or https and include a hostname.');
    }
    return parsed;
}

function redirectRequest(status: number, init: RequestInit): RequestInit {
    const method = (init.method ?? 'GET').toUpperCase();
    if (status !== 303 && !((status === 301 || status === 302) && method === 'POST')) return init;
    const headers = new Headers(init.headers);
    headers.delete('content-length');
    headers.delete('content-type');
    const { body: _body, ...withoutBody } = init;
    return { ...withoutBody, method: 'GET', headers };
}

function contentLength(response: Response): number | null {
    const raw = response.headers.get('content-length');
    if (raw === null || !/^\d+$/u.test(raw)) return null;
    const parsed = Number(raw);
    return Number.isSafeInteger(parsed) ? parsed : null;
}
