import { type IStepExecutor } from './IStepExecutor.js';
import { type Step } from '../types/index.js';

export class RestApiExecutor implements IStepExecutor {
    async execute(step: Step, context: Record<string, any>): Promise<any> {
        const params = step.STEP_PARAMS;
        const url = params?.URL;
        const method = params?.METHOD || 'GET';
        const headers = params?.HEADERS || {};
        const timeoutMs = params?.TIMEOUT_MS ?? 10000;

        console.log(`[RESTAPI] Executing HTTP ${method} request to ${url}`);
        
        if (!url) {
            throw new Error("RESTAPI execution failed: URL param is missing.");
        }
        
        try {
            const response = await fetch(url, {
                method: method,
                headers: headers,
                signal: AbortSignal.timeout(timeoutMs || 10000)
            });
            
            
            let data;
            const contentType = response.headers.get("content-type");
            if (contentType && contentType.includes("application/json")) {
                data = await response.json();
            } else {
                data = await response.text();
            }

            if (!response.ok) {
                throw new Error(
                    `RESTAPI request failed with status ${response.status}: ${JSON.stringify(data)}`
                );
            }
                        
            return { 
                status: response.status, 
                data: data 
            };
        } catch (error: any) {
            if (error.name === 'TimeoutError' || error.name === 'AbortError') {
                throw new Error(
                    `RESTAPI execution failed: request timed out after ${timeoutMs}ms.`
                );
            } 
            throw new Error(`RESTAPI execution failed: ${error.message}`);

        }
    }
}