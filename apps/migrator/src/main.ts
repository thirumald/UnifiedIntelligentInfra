/**
 * dt-platform migrator — applies versioned SQL to both persistence stores.
 *
 *  sql/postgis/*.sql    → PostGIS asset registry
 *  sql/timescale/*.sql  → TimescaleDB telemetry store
 *
 * Rules
 *  - Files apply in lexical order, once, tracked in dt_schema_migrations.
 *  - A file whose checksum changed after being applied aborts the run
 *    (migrations are immutable — add a new file instead).
 *  - `-- migrate:no-transaction` on the first line runs the file outside a
 *    transaction (needed for Timescale continuous aggregates).
 *  - `-- migrate:seed` files only run when SEED_DEMO_DATA=true.
 *  - `{{VAR}}` placeholders are substituted from the environment.
 *  - A session advisory lock makes concurrent migrator runs safe.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger, envs, loadEnv, postgisEnv, retry, timescaleEnv } from '@dt/common';
import { createPostgisPool, createTimescalePool, type Pool } from '@dt/db';
import { z } from 'zod';

const env = loadEnv(
  z.object({
    ...postgisEnv,
    ...timescaleEnv,
    SEED_DEMO_DATA: envs.bool(true),
    TSDB_RETENTION_DAYS: envs.int(90),
    TSDB_COMPRESS_AFTER_DAYS: envs.int(7),
    MIGRATIONS_DIR: envs.str(join(__dirname, '..', 'sql')),
  }),
);

const log = createLogger('migrator');
const LOCK_KEY = 727_001; // arbitrary, stable

interface Store {
  name: 'postgis' | 'timescale';
  pool: Pool;
}

function render(sql: string): string {
  return sql.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_m, key: string) => {
    const value = (env as Record<string, unknown>)[key] ?? process.env[key];
    if (value === undefined) throw new Error(`Missing template variable {{${key}}}`);
    return String(value);
  });
}

async function migrate(store: Store): Promise<void> {
  const dir = join(env.MIGRATIONS_DIR, store.name);
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const client = await store.pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS dt_schema_migrations (
        filename    TEXT PRIMARY KEY,
        checksum    TEXT NOT NULL,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        duration_ms INTEGER NOT NULL
      )`);
    const applied = new Map<string, string>(
      (await client.query<{ filename: string; checksum: string }>('SELECT filename, checksum FROM dt_schema_migrations')).rows.map(
        (r) => [r.filename, r.checksum],
      ),
    );

    for (const file of files) {
      const raw = await readFile(join(dir, file), 'utf8');
      const sql = render(raw);
      const checksum = createHash('sha256').update(sql).digest('hex');
      const prior = applied.get(file);

      if (prior) {
        if (prior !== checksum) {
          throw new Error(`[${store.name}] ${file} was modified after being applied (checksum mismatch)`);
        }
        continue;
      }
      if (raw.includes('-- migrate:seed') && !env.SEED_DEMO_DATA) {
        log.info({ store: store.name, file }, 'skipping seed file (SEED_DEMO_DATA=false)');
        continue;
      }

      const noTx = raw.trimStart().startsWith('-- migrate:no-transaction');
      const started = Date.now();
      log.info({ store: store.name, file, transactional: !noTx }, 'applying migration');
      try {
        if (noTx) {
          await client.query(sql);
        } else {
          await client.query('BEGIN');
          await client.query(sql);
        }
        await client.query('INSERT INTO dt_schema_migrations (filename, checksum, duration_ms) VALUES ($1, $2, $3)', [
          file,
          checksum,
          Date.now() - started,
        ]);
        if (!noTx) await client.query('COMMIT');
      } catch (err) {
        if (!noTx) await client.query('ROLLBACK').catch(() => undefined);
        throw new Error(`[${store.name}] ${file} failed: ${(err as Error).message}`);
      }
      log.info({ store: store.name, file, ms: Date.now() - started }, 'migration applied');
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    client.release();
  }
}

async function main(): Promise<void> {
  const onPoolError = (err: Error) => log.error({ err }, 'pool error');
  const stores: Store[] = [
    { name: 'postgis', pool: createPostgisPool(env, 'migrator', onPoolError) },
    { name: 'timescale', pool: createTimescalePool(env, 'migrator', onPoolError) },
  ];
  try {
    for (const store of stores) {
      await retry(() => store.pool.query('SELECT 1'), { logger: log, label: `${store.name} connect`, retries: 20 });
      await migrate(store);
    }
    log.info('all migrations applied');
  } finally {
    await Promise.all(stores.map((s) => s.pool.end()));
  }
}

main().catch((err: Error) => {
  log.fatal({ err: err.message }, 'migration run failed');
  process.exit(1);
});
