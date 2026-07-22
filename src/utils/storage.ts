import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const JOBS_FILE = path.join(__dirname, '../../jobs.json');

export const LOGS_FILE = path.join(__dirname, '../../logs.json');

/**
 * Every file has its own mutation queue.
 * This protects the complete read -> modify -> write operation.
 */

const mutationQueues = new Map<string, Promise<void>>();

export async function readJsonFile<T>(filePath: string): Promise<T[]> {
    try {
        const data = await fs.readFile(filePath, 'utf-8');
        const parsedData: unknown = JSON.parse(data);

        if (!Array.isArray(parsedData)) {
            throw new Error(`JSON storage file must contain an array: ${filePath}`);
        }

        return parsedData as T[];
    } catch (error: unknown) {
        if (getErrorCode(error) === 'ENOENT') {
            return [];
        }

        throw error;
    }
  }

  
export async function writeJsonFile<T>(filePath: string, data: readonly T[]): Promise<void> {
    await enqueueFileMutation(filePath, async () => {
            await writeJsonFileAtomically(filePath, data);
    });
}

export async function updateJsonFile<T, TResult>(filePath: string, updater: (currentItems: T[]) => TResult | Promise<TResult>): Promise<TResult> {
    return enqueueFileMutation(filePath,
        async () => {
            const currentItems = await readJsonFile<T>(filePath);
            const result = await updater(currentItems);
            await writeJsonFileAtomically(filePath, currentItems);
            return result;
        }
    );
}

async function writeJsonFileAtomically<T>(filePath: string, data: readonly T[]): Promise<void> {
    const directory = path.dirname(filePath);
    const fileName = path.basename(filePath);

    const temporaryFilePath = path.join(directory, `.${fileName}.${process.pid}.${randomUUID()}.tmp`);

    const serializedData = JSON.stringify(data, null, 2);

    if (serializedData === undefined) {
        throw new Error(`Could not serialize JSON data for: ${filePath}`);
    }

    await fs.mkdir(directory, {recursive: true});

    try {
        await fs.writeFile(temporaryFilePath, `${serializedData}\n`,{encoding: 'utf-8', flag: 'wx'});
        await fs.rename(temporaryFilePath, filePath);
    } catch (error: unknown) {
        await fs.rm(temporaryFilePath,{ force: true }).catch(() => undefined);
        throw error;
    }
}

function enqueueFileMutation<TResult>(filePath: string, operation: () => Promise<TResult>): Promise<TResult> {
    const queueKey = path.resolve(filePath);

    const previousMutation = mutationQueues.get(queueKey) ?? Promise.resolve();

    const currentMutation = previousMutation.then(operation);

    // A rejected operation must not permanently block later writes.
    const queueTail = currentMutation.then(() => undefined,() => undefined);

    mutationQueues.set(queueKey, queueTail);

    void queueTail.then(() => {if (mutationQueues.get(queueKey) === queueTail) {mutationQueues.delete(queueKey);}});

    return currentMutation;
}

function getErrorCode(error: unknown): unknown {
    if (typeof error === 'object' && error !== null && 'code' in error) {
        return error.code;
    }

    return undefined;
}