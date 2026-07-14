
import { type IStepExecutor } from './IStepExecutor.js';
import { type Step } from '../types/index.js';
import vm from 'vm'; // Native Node.js module

export class ScriptExecutor implements IStepExecutor {
    async execute(step: Step, context: Record<string, any>): Promise<any> {
        const code = step.STEP_PARAMS?.CODE;
        console.log(`[SCRIPT] Evaluating script for step ${step.NAME}`);
        
        if (!code) throw new Error("Script execution failed: CODE param is missing.");

        // 1. Define what the script is allowed to access
        // We only give it the 'context' object. No access to Node.js internals.
        const sandbox = { 
            context: context, 
            result: null 
        };
        vm.createContext(sandbox);

        const scriptCode = `
            const userFunction = ${code};
            result = userFunction(context);
        `;

        try {
            const script = new vm.Script(scriptCode);
            
            script.runInContext(sandbox, { timeout: 2000 }); 
            
            return sandbox.result;
        } catch (error: any) {
            throw new Error(`Script Sandbox Error: ${error.message}`);
        }
    }
}