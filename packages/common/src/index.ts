import pino, { type Logger } from 'pino';
import { z, type ZodTypeAny } from 'zod';

export type { Logger } from 'pino';

/* -------------------------------------------------------------------------- */
/*  Logging                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Structured JSON logger. One line per event, ready for Loki / ELK.
 * Secrets in well-known fields are redacted at source.
 */
export function createLogger(service: string, level = process.env.LOG_LEVEL ?? 'info'): Logger {
  return pino({
    name: service,
    level,
    base: { service, pid: process.pid },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: ['password', '*.password', 'token', '*.token', 'authorization', '*.authorization', 'req.headers.authorization'],
      censor: '[redacted]',
    },
    formatters: { level: (label) => ({ level: label }) },
  });
}

/* -------------------------------------------------------------------------- */
/*  Configuration                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Validate process.env against a zod schema. Fails fast at boot with a
 * readable list of every missing / malformed variable.
 */
export function loadEnv<S extends ZodTypeAny>(schema: S, env: NodeJS.ProcessEnv = process.env): z.infer<S> {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
    // eslint-disable-next-line no-console
    console.error(`Invalid environment configuration:\n${issues}`);
    process.exit(78); // EX_CONFIG
  }
  return parsed.data;
}

/** Reusable env field builders */
export const envs = {
  str: (def?: string) => (def === undefined ? z.string().min(1) : z.string().min(1).default(def)),
  int: (def?: number) => (def === undefined ? z.coerce.number().int() : z.coerce.number().int().default(def)),
  num: (def?: number) => (def === undefined ? z.coerce.number() : z.coerce.number().default(def)),
  bool: (def = false) =>
    z
      .enum(['true', 'false', '1', '0', 'yes', 'no'])
      .default(def ? 'true' : 'false')
      .transform((v) => v === 'true' || v === '1' || v === 'yes'),
  list: (def = '') =>
    z
      .string()
      .default(def)
      .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean)),
};

/** Postgres connection settings shared by both stores */
export const postgisEnv = {
  POSTGIS_HOST: envs.str('postgis'),
  POSTGIS_PORT: envs.int(5432),
  POSTGIS_DB: envs.str('dt_assets'),
  POSTGIS_USER: envs.str('dt_assets'),
  POSTGIS_PASSWORD: envs.str(),
  POSTGIS_POOL_MAX: envs.int(20),
};

export const timescaleEnv = {
  TSDB_HOST: envs.str('timescaledb'),
  TSDB_PORT: envs.int(5432),
  TSDB_DB: envs.str('dt_telemetry'),
  TSDB_USER: envs.str('dt_telemetry'),
  TSDB_PASSWORD: envs.str(),
  TSDB_POOL_MAX: envs.int(20),
};

export const kafkaEnv = {
  KAFKA_BROKERS: envs.list('kafka:29092'),
  KAFKA_CLIENT_ID: envs.str('dt-platform'),
};

export const redisEnv = {
  REDIS_URL: envs.str('redis://redis:6379'),
  REDIS_PASSWORD: z.string().optional(),
  REDIS_STATE_CHANNEL_PREFIX: envs.str('dt:state'),
};

/* -------------------------------------------------------------------------- */
/*  Lifecycle                                                                  */
/* -------------------------------------------------------------------------- */

type ShutdownHook = () => Promise<unknown> | unknown;

/**
 * Register SIGTERM/SIGINT handlers that run hooks in reverse registration
 * order (last-opened resource closes first) with a hard timeout.
 */
export function onShutdown(logger: Logger, hooks: ShutdownHook[], timeoutMs = 15_000): void {
  let shuttingDown = false;
  const run = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutdown requested');
    const timer = setTimeout(() => {
      logger.error('shutdown timed out — forcing exit');
      process.exit(1);
    }, timeoutMs);
    timer.unref();
    for (const hook of [...hooks].reverse()) {
      try {
        await hook();
      } catch (err) {
        logger.error({ err }, 'shutdown hook failed');
      }
    }
    logger.info('shutdown complete');
    process.exit(0);
  };
  process.once('SIGTERM', () => void run('SIGTERM'));
  process.once('SIGINT', () => void run('SIGINT'));
  process.on('unhandledRejection', (reason) => logger.error({ reason }, 'unhandled rejection'));
}

/* -------------------------------------------------------------------------- */
/*  Utilities                                                                  */
/* -------------------------------------------------------------------------- */

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Retry with exponential back-off + jitter — used for dependency start-up. */
export async function retry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: { retries?: number; minMs?: number; maxMs?: number; logger?: Logger; label?: string } = {},
): Promise<T> {
  const { retries = 30, minMs = 500, maxMs = 10_000, logger, label = 'operation' } = opts;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      const delay = Math.min(maxMs, minMs * 2 ** (attempt - 1)) * (0.75 + Math.random() * 0.5);
      logger?.warn({ attempt, retries, delayMs: Math.round(delay), err: (err as Error).message }, `${label} failed, retrying`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

/** Resolve a dot-path ("a.b.0.c") or "$.a.b" into an object. */
export function getPath(obj: unknown, path: string): unknown {
  const clean = path.startsWith('$.') ? path.slice(2) : path === '$' ? '' : path;
  if (!clean) return obj;
  let cur: unknown = obj;
  for (const key of clean.split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/**
 * kafkajs logCreator that routes client logs through pino (structured,
 * level-mapped) instead of kafkajs' own console JSON.
 * kafkajs levels: NOTHING=0, ERROR=1, WARN=2, INFO=4, DEBUG=5
 */
export function kafkaLogCreator(logger: Logger) {
  return () =>
    ({ level, log: entry }: { namespace: string; level: number; label: string; log: { message: string } & Record<string, unknown> }) => {
      const { message, ...rest } = entry;
      const fields = { kafka: rest.broker ?? rest.groupId ?? undefined, err: rest.error };
      if (level <= 1) logger.error(fields, `kafka: ${message}`);
      else if (level === 2) logger.warn(fields, `kafka: ${message}`);
      else if (level === 4) logger.info(fields, `kafka: ${message}`);
      else logger.debug(fields, `kafka: ${message}`);
    };
}
