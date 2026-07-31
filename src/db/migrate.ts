import { loadConfig } from '../config.js';
import { createPool } from './pool.js';
import { migrate } from './migrations.js';

const config = loadConfig();
const pool = createPool(config.databaseUrl, config.dbPoolMax);

try {
    const version = await migrate(pool);
    console.log(`Database migrations complete at version ${version}.`);
} finally {
    await pool.end();
}
