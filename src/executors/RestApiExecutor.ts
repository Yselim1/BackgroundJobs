import { type IStepExecutor } from './IStepExecutor.js';
import type { Step, HttpMethod, RestApiStepParams, RestApiResponseType, RestApiStepOutput } from '../types/index.js';
import { resolveContextTemplates} from '../utils/contextResolver.js';

const DEFAULT_TIMEOUT_MS = 10000;

const SUPPORTED_HTTP_METHODS = new Set<HttpMethod>([
    'GET',
    'POST',
    'PUT',
    'PATCH',
    'DELETE',
    'HEAD',
    'OPTIONS'
]);

export class RestApiExecutor implements IStepExecutor {
    async execute(step: Step, context: Record<string, any>): Promise<RestApiStepOutput> {
        let timeoutMs = DEFAULT_TIMEOUT_MS;

        try{
            const params = step.STEP_PARAMS as RestApiStepParams | undefined;
            if(!params){
                throw new Error('STEP_PARAMS are missing.');
            }

            const method = resolveMethod(params.METHOD);
            timeoutMs = resolveTimeout(params.TIMEOUT_MS);
            const responseType = resolveResponseType(params.RESPONSE_TYPE);

            /**
               * A REST step may only consume context from steps explicitly
               * listed in DEPENDS_ON.
            */

            const resolutionOptions = {
                  allowedStepIds: new Set(step.DEPENDS_ON ?? [])
            };
            const resolvedUrl: unknown = resolveContextTemplates(
                  params.URL,
                  context,
                  resolutionOptions
            );

            const resolvedHeaders: unknown = resolveContextTemplates(
                  params.HEADERS ?? {},
                  context,
                  resolutionOptions
            );

            const resolvedQuery: unknown = resolveContextTemplates(
                  params.QUERY ?? {},
                  context,
                  resolutionOptions
            );

            const resolvedBody: unknown = params.BODY === undefined ? undefined : 
                resolveContextTemplates(
                    params.BODY,
                    context,
                    resolutionOptions
            );

            const requestUrl = buildRequestUrl(
                  resolvedUrl,
                  resolvedQuery
            );

            const headers = buildHeaders(resolvedHeaders);

            const body = serializeRequestBody(
                method,
                resolvedBody,
                headers
            );
            
            console.log(`[RESTAPI] Executing HTTP ${method} request to ${requestUrl}`);

            const requestInit: RequestInit = {
                  method,
                  headers,
                  signal: AbortSignal.timeout(timeoutMs)
              };

            if (body !== undefined) {
                  requestInit.body = body;
            }
            
            const response = await fetch(requestUrl, requestInit);

            const data = await parseResponseBody(response, method, responseType);
        
            if (!response.ok) {
                throw new Error(buildHttpErrorMessage(response, data));
            }
        
            return {
                status: response.status,
                statusText: response.statusText,
                headers: headersToRecord(response.headers),
                data
            };
        }catch (error: unknown) {
            const resolvedError = error instanceof Error ? error : new Error(String(error));
            
            if (resolvedError.name === 'TimeoutError' || resolvedError.name === 'AbortError') {

                throw new Error(`RESTAPI execution failed: request timed out ` + `after ${timeoutMs}ms.`);
            }

            throw new Error(
                `RESTAPI execution failed: ${resolvedError.message}`
            );
        }
    }    
}

function resolveMethod(methodValue: unknown): HttpMethod {
    if (methodValue !== undefined && typeof methodValue !== 'string') {
        throw new Error('METHOD must be a string.');
    }
    
    const method = (methodValue ?? 'GET').trim().toUpperCase();

    if (!SUPPORTED_HTTP_METHODS.has(method as HttpMethod)) {
        throw new Error(
            `Unsupported HTTP method: "${method}".`
        );
    }
    return method as HttpMethod;
}

function resolveTimeout(timeoutValue: unknown): number {
    if (timeoutValue === undefined) {
        return DEFAULT_TIMEOUT_MS;
    }
    if (typeof timeoutValue !== 'number' || !Number.isInteger(timeoutValue) || timeoutValue <= 0
    ) {
        throw new Error(
            'TIMEOUT_MS must be a positive integer.'
        );
    }
    return timeoutValue;
}

function buildRequestUrl(urlValue: unknown, queryValue: unknown):string {
    if (typeof urlValue !== 'string' || urlValue.trim().length === 0) {
        throw new Error('URL must resolve to a non-empty string.');
    }

    let requestUrl: URL;
    try {
        requestUrl = new URL(urlValue);
    } catch {
        throw new Error(`Invalid URL: "${urlValue}".`);
    }
    appendQueryParameters(requestUrl, queryValue);
    return requestUrl.toString();
}


function appendQueryParameters(requestUrl: URL, queryValue: unknown): void {
    if (!isRecord(queryValue)) {
        throw new Error('QUERY must resolve to an object.');
    }
    
    for (const [name, rawValue] of Object.entries(queryValue)) {

        const values = Array.isArray(rawValue)? rawValue : [rawValue];
        
        for (const value of values) {
            // Null query values are treated as skipped optional values.
            if (value === null || value === undefined) {
                continue;
            }
            if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
                throw new Error(`QUERY parameter "${name}" must be a ` +'string, number, boolean, null, or an array of them.');
            }
            
            requestUrl.searchParams.append(name, String(value));
        }
    }
}

function buildHeaders(headersValue: unknown): Headers {
    if (!isRecord(headersValue)) {
        throw new Error('HEADERS must resolve to an object.');
    }

    const headers = new Headers();
    for (const [name, value] of Object.entries(headersValue)) {
        if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
            throw new Error(`Header "${name}" must resolve to a scalar value.`);
        }
        headers.set(name, String(value));
    }
    return headers;
}

function serializeRequestBody(method: HttpMethod, bodyValue: unknown, headers: Headers): string | undefined {
    if (bodyValue === undefined) {
        return undefined;
    }

    if (method === 'GET' || method === 'HEAD') {
        throw new Error(`${method} requests cannot contain a BODY.`);
    }

    if (typeof bodyValue === 'string') {
        return bodyValue;
    }

    let serializedBody: string | undefined;
    try {
        serializedBody = JSON.stringify(bodyValue);
    } catch (error: unknown) {
        const message = error instanceof Error? error.message : String(error);

        throw new Error(`BODY could not be JSON serialized: ${message}`);
    }

    if (serializedBody === undefined) {
        throw new Error('BODY could not be JSON serialized.');
    }
    
    if (!headers.has('Content-Type')) {
        headers.set('Content-Type', 'application/json');
    }
    return serializedBody;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return (value !== null && typeof value === 'object' && !Array.isArray(value));
}


function resolveResponseType(responseTypeValue: unknown): RestApiResponseType {
    if (responseTypeValue === undefined) {
        return 'auto';
    }
    if (typeof responseTypeValue !== 'string') {
        throw new Error('RESPONSE_TYPE must be a string.');
    }
    const responseType = responseTypeValue.trim().toLowerCase();
    if (responseType !== 'auto' && responseType !== 'json' && responseType !== 'text') {
        throw new Error(`Unsupported RESPONSE_TYPE: "${responseType}".`);
    }
    return responseType;
}

async function parseResponseBody(response: Response, method: HttpMethod, responseType: RestApiResponseType): Promise<unknown> {
    // HEAD responses and these status codes will not have a meaningful response body.
    if (method === 'HEAD' || response.status === 204 || response.status === 205 || response.status === 304) return null;
    
    const responseText = await response.text();
    if (responseText.length === 0) return null;
    
    if (responseType === 'text') return responseText;

    if (responseType === 'json') {
        return parseJsonResponse(responseText, response.status);
    }
    /**
     * In auto mode, parse JSON only when the server identifies the
     * response as JSON. Mislabelled invalid JSON falls back to text.
     */
    const contentType = response.headers.get('content-type') ?? '';
    if (isJsonContentType(contentType)) {
        try {
            return JSON.parse(responseText);
        } catch {
            return responseText;
        }
    }
    return responseText;
}

function parseJsonResponse(responseText: string, status: number): unknown {
    try {
        return JSON.parse(responseText);
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`HTTP ${status} response could not be parsed ` + `as JSON: ${message}`);
    }
}

function isJsonContentType(contentType: string): boolean {
    const mimeType = contentType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
    
    return (mimeType === 'application/json' || mimeType.endsWith('+json'));
}

function headersToRecord(headers: Headers): Record<string, string> {
    const result: Record<string, string> = {};
    headers.forEach((value, name) => {
        result[name] = value;
    });
    return result;
}

function buildHttpErrorMessage(response: Response, data: unknown): string {
    const statusText = response.statusText ? ` ${response.statusText}` : '';
    return (
        `HTTP request failed with status ` +
        `${response.status}${statusText}. ` +
        `Response body: ${formatResponseData(data)}`
    );
}

function formatResponseData(data: unknown): string {
    if (data === null || data === undefined) return '<empty>';
    
    if (typeof data === 'string') {
        return data.length > 0? data: '<empty>';
    }
    
    try {
        const serialized = JSON.stringify(data);
        return serialized ?? String(data);
    } catch {
        return String(data);
    }
}