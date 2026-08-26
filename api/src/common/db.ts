import pg from 'pg';
import type { Pool, PoolClient } from 'pg';
import { env } from '../config/env';
import { describeError } from './errors';
import { logger } from './logger';

/**
 * Shared PostgreSQL connection pool.
 *
 * Created lazily rather than at import time so that importing anything from
 * this module (e.g. in a unit test) does not open sockets as a side effect.
 */
let pool: Pool | undefined;

export function getPool(): Pool {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: env.DATABASE_URL,
      // Fail fast. Without this a health check or request can hang for the OS
      // default TCP timeout when the database is unreachable.
      connectionTimeoutMillis: 2000,
      idleTimeoutMillis: 10_000,
      max: 10,
    });

    // REQUIRED, not optional: a pg Pool with no 'error' listener will throw an
    // uncaught exception and kill the process when an *idle* client errors
    // (e.g. the database restarts). We log and let the pool recover instead.
    pool.on('error', (err: Error) => {
      logger.error('pg_pool_error', describeError(err));
    });
  }

  return pool;
}

/**
 * Is the database reachable and answering queries? Never throws — a dead
 * dependency is something we report, not something that crashes the API.
 */
export async function pingDatabase(): Promise<boolean> {
  try {
    const result = await getPool().query<{ ok: number }>('SELECT 1 AS ok');
    return result.rows[0]?.ok === 1;
  } catch (err) {
    logger.warn('db_ping_failed', describeError(err));
    return false;
  }
}

/** Run a callback with a dedicated client (use for transactions later). */
export async function withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

/**
 * Close all pooled connections. Called on shutdown and in tests — an open pool
 * keeps the Node event loop alive and makes the process hang on exit.
 */
export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
