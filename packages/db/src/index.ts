import pg, { type Pool, type PoolClient, type PoolConfig, type QueryResultRow } from 'pg';

export type { Pool, PoolClient, QueryResultRow } from 'pg';

/*
 * Polyglot persistence:
 *   - PostGIS     → asset registry, hierarchy, geometry, BIM placement, device mappings
 *   - TimescaleDB → telemetry hypertables, anomalies, continuous aggregates
 * Each store gets its own pool so a telemetry write storm can never starve
 * spatial API queries of connections.
 */

// int8 → JS number (counts / epoch millis stay well below 2^53)
pg.types.setTypeParser(20, (v) => Number.parseInt(v, 10));
// numeric → number (thresholds, measurements)
pg.types.setTypeParser(1700, (v) => Number.parseFloat(v));

export interface StoreConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  max?: number;
  applicationName: string;
  /** Per-statement timeout guard against runaway spatial queries */
  statementTimeoutMs?: number;
}

export function createPool(cfg: StoreConfig, onError?: (err: Error) => void): Pool {
  const config: PoolConfig = {
    host: cfg.host,
    port: cfg.port,
    database: cfg.database,
    user: cfg.user,
    password: cfg.password,
    max: cfg.max ?? 20,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: cfg.applicationName,
    statement_timeout: cfg.statementTimeoutMs ?? 30_000,
    keepAlive: true,
  };
  const pool = new pg.Pool(config);
  // An idle client erroring (e.g. DB restart) must not crash the process
  pool.on('error', (err) => onError?.(err));
  return pool;
}

export interface PostgisEnv {
  POSTGIS_HOST: string;
  POSTGIS_PORT: number;
  POSTGIS_DB: string;
  POSTGIS_USER: string;
  POSTGIS_PASSWORD: string;
  POSTGIS_POOL_MAX: number;
}

export interface TimescaleEnv {
  TSDB_HOST: string;
  TSDB_PORT: number;
  TSDB_DB: string;
  TSDB_USER: string;
  TSDB_PASSWORD: string;
  TSDB_POOL_MAX: number;
}

export function createPostgisPool(env: PostgisEnv, app: string, onError?: (err: Error) => void): Pool {
  return createPool(
    {
      host: env.POSTGIS_HOST,
      port: env.POSTGIS_PORT,
      database: env.POSTGIS_DB,
      user: env.POSTGIS_USER,
      password: env.POSTGIS_PASSWORD,
      max: env.POSTGIS_POOL_MAX,
      applicationName: `${app}:postgis`,
    },
    onError,
  );
}

export function createTimescalePool(env: TimescaleEnv, app: string, onError?: (err: Error) => void): Pool {
  return createPool(
    {
      host: env.TSDB_HOST,
      port: env.TSDB_PORT,
      database: env.TSDB_DB,
      user: env.TSDB_USER,
      password: env.TSDB_PASSWORD,
      max: env.TSDB_POOL_MAX,
      applicationName: `${app}:timescale`,
      statementTimeoutMs: 60_000,
    },
    onError,
  );
}

/** Run fn inside BEGIN/COMMIT; rolls back on any error. */
export async function withTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Typed single-row helper; returns null when no row. */
export async function queryOne<T extends QueryResultRow>(
  pool: Pool | PoolClient,
  text: string,
  values: unknown[] = [],
): Promise<T | null> {
  const res = await pool.query<T>(text, values);
  return res.rows[0] ?? null;
}

/** Liveness probe used by /health/ready */
export async function ping(pool: Pool): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}
