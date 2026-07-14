import { type IStepExecutor } from './IStepExecutor.js';
import { type Step } from '../types/index.js';
import { exec } from 'child_process';
import util from 'util';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

// exec fonksiyonunu Promise tabanlı kullanabilmek için çeviriyoruz
const execPromise = util.promisify(exec);

export class PythonExecutor implements IStepExecutor {
    async execute(step: Step, context: Record<string, any>): Promise<any> {
        const code = step.STEP_PARAMS?.CODE;
        if (!code) throw new Error("Python execution failed: CODE param is missing.");

        
        const tmpDir = os.tmpdir();
        const fileName = `job_${Date.now()}_${Math.floor(Math.random() * 1000)}.py`;
        const filePath = path.join(tmpDir, fileName);

        // Not: Eğer Python'a önceki adımların verisini (context) göndermek isterseniz,
        // context objesini de 'context.json' olarak diske yazıp Python'un okumasını sağlayabilirsiniz.

        try {
            
            await fs.writeFile(filePath, code, 'utf-8');
            console.log(`[PYTHON] Executing script at ${filePath}`);

            
            const { stdout, stderr } = await execPromise(`python ${filePath}`, { timeout: 5000 });
            
            if (stderr) {
                console.warn(`[PYTHON] Warning/Stderr: ${stderr}`);
            }

            
            try {
                return JSON.parse(stdout.trim());
            } catch {
                return { raw_output: stdout.trim() };
            }

        } catch (error: any) {
            throw new Error(`Python Child Process Error: ${error.message}`);
        } finally {
            
            await fs.unlink(filePath).catch(() => console.error("Could not delete temp file."));
        }
    }
}