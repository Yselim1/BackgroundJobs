import pg from 'pg';

const { Pool } = pg;

export type DatabasePool = pg.Pool;
export type DatabaseClient = pg.PoolClient;

export function createPool(databaseUrl: string, max = 10): DatabasePool {
    return new Pool({ connectionString: databaseUrl, max });
}

export async function withTransaction<T>(pool: DatabasePool, work: (client: DatabaseClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await work(client);
        await client.query('COMMIT');
        return result;
    } catch (error: unknown) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

export function isUniqueViolation(error: unknown, constraint?: string): boolean {
    if (!(error instanceof Error) || !('code' in error) || error.code !== '23505') return false;
    return constraint === undefined || ('constraint' in error && error.constraint === constraint);
}

