import { envs, kafkaEnv, loadEnv, postgisEnv, redisEnv, timescaleEnv } from '@dt/common';
import { z } from 'zod';

export const ApiEnvSchema = z.object({
  NODE_ENV: envs.str('production'),
  PORT: envs.int(4000),
  API_GLOBAL_PREFIX: envs.str('api/v1'),
  WS_PATH: envs.str('/realtime/socket.io'),
  CORS_ORIGINS: envs.list('http://localhost:3000'),
  TENANT_ID: envs.str('default'),

  // Auth
  AUTH_DISABLED: envs.bool(false),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_ISSUER: envs.str('dt-platform'),
  JWT_AUDIENCE: envs.str('dt-platform-clients'),
  JWT_TTL_SECONDS: envs.int(8 * 3600),
  AUTH_ADMIN_USERNAME: envs.str('admin'),
  AUTH_ADMIN_PASSWORD: z.string().min(8, 'AUTH_ADMIN_PASSWORD must be at least 8 characters'),
  AUTH_VIEWER_USERNAME: envs.str('viewer'),
  AUTH_VIEWER_PASSWORD: z.string().min(8).optional(),

  // BIM / IFC
  IFC_STORAGE_DIR: envs.str('/data/ifc'),
  IFC_MAX_UPLOAD_MB: envs.int(200),

  // Topics
  TOPIC_TELEMETRY_RAW: envs.str('dt.telemetry.raw'),
  TOPIC_ASSET_EVENTS: envs.str('dt.asset.events'),
  TOPIC_IFC_JOBS: envs.str('dt.ifc.jobs'),

  ...postgisEnv,
  ...timescaleEnv,
  ...kafkaEnv,
  ...redisEnv,
});

export type ApiEnv = z.infer<typeof ApiEnvSchema>;

let cached: ApiEnv | null = null;
/** Validated once at boot; decorators that need static values call this too. */
export function apiEnv(): ApiEnv {
  cached ??= loadEnv(ApiEnvSchema);
  return cached;
}

export const API_ENV = Symbol('API_ENV');
