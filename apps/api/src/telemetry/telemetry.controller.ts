import { Body, Controller, Get, HttpCode, Inject, Module, NotFoundException, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { DeviceStateSnapshot, Reading, RedisChannels, type TelemetryEnvelope } from '@dt/contracts';
import type { Pool } from '@dt/db';
import type { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AssetsModule } from '../assets/assets.controller';
import { AssetsService } from '../assets/assets.service';
import { CurrentUser, RequireRole, type Principal } from '../auth/auth';
import { ZodPipe } from '../common/zod.pipe';
import { API_ENV, type ApiEnv } from '../config';
import { EventBus, REDIS, TSDB } from '../infra/infra.module';

const SeriesQuery = z
  .object({
    deviceId: z.string().max(128).optional(),
    assetId: z.string().uuid().optional(),
    metric: z.string().regex(/^[a-z][a-z0-9_]*$/),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
  })
  .refine((q) => q.deviceId || q.assetId, 'deviceId or assetId is required');

const IngestBody = z.object({
  deviceId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
  ts: z.number().int().positive().optional(),
  readings: z.array(Reading).min(1).max(500),
});

const AnomalyQuery = z.object({
  open: z.enum(['true', 'false']).optional(),
  assetId: z.string().uuid().optional(),
  severity: z.enum(['info', 'warning', 'critical']).optional(),
  hours: z.coerce.number().int().min(1).max(24 * 90).default(24),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
});

/**
 * Resolution is chosen from the requested window so a chart never pulls
 * more than ~1–2k points: raw 10 s buckets ≤ 1 h, 1-minute CAGG ≤ 2 days,
 * 1-hour CAGG beyond.
 */
function resolution(fromMs: number, toMs: number): { source: 'raw' | '1m' | '1h'; label: string } {
  const span = toMs - fromMs;
  if (span <= 3_600_000) return { source: 'raw', label: '10s' };
  if (span <= 2 * 86_400_000) return { source: '1m', label: '1m' };
  return { source: '1h', label: '1h' };
}

@Controller()
export class TelemetryController {
  constructor(
    @Inject(TSDB) private readonly tsdb: Pool,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(API_ENV) private readonly env: ApiEnv,
    private readonly assets: AssetsService,
    private readonly bus: EventBus,
  ) {}

  /** Latest state of every device (or a subset) — served from Redis */
  @Get('telemetry/latest')
  async latest(@CurrentUser() u: Principal, @Query('deviceIds') deviceIds?: string) {
    const key = RedisChannels.latestHash(u.tenantId);
    const ids = deviceIds?.split(',').filter(Boolean);
    const raw = ids?.length ? await this.redis.hmget(key, ...ids) : Object.values(await this.redis.hgetall(key));
    return raw.filter((v): v is string => !!v).map((v) => DeviceStateSnapshot.parse(JSON.parse(v)));
  }

  @Get('telemetry/series')
  async series(@CurrentUser() u: Principal, @Query(new ZodPipe(SeriesQuery)) q: z.infer<typeof SeriesQuery>) {
    const to = q.to?.getTime() ?? Date.now();
    const from = q.from?.getTime() ?? to - 3_600_000;
    const deviceIds = q.deviceId ? [q.deviceId] : await this.assets.deviceIdsForAssets(u.tenantId, [q.assetId!]);
    if (!deviceIds.length) return { metric: q.metric, resolution: null, points: [] };

    const res = resolution(from, to);
    const params = [u.tenantId, deviceIds, q.metric, new Date(from), new Date(to)];
    const sql =
      res.source === 'raw'
        ? `SELECT time_bucket(INTERVAL '10 seconds', time) AS t, avg(value_num) AS avg, min(value_num) AS min, max(value_num) AS max
           FROM telemetry
           WHERE tenant_id = $1 AND device_id = ANY($2::text[]) AND metric = $3 AND time BETWEEN $4 AND $5 AND value_num IS NOT NULL
           GROUP BY 1 ORDER BY 1`
        : `SELECT bucket AS t, avg(value_avg) AS avg, min(value_min) AS min, max(value_max) AS max
           FROM telemetry_${res.source}
           WHERE tenant_id = $1 AND device_id = ANY($2::text[]) AND metric = $3 AND bucket BETWEEN $4 AND $5
           GROUP BY 1 ORDER BY 1`;
    const { rows } = await this.tsdb.query<{ t: Date; avg: number; min: number; max: number }>(sql, params);
    return {
      metric: q.metric,
      resolution: res.label,
      points: rows.map((r) => ({ t: r.t.getTime(), avg: r.avg, min: r.min, max: r.max })),
    };
  }

  /** Metrics a device / asset has reported in the last 24 h (drives the chart picker) */
  @Get('telemetry/metrics')
  async metrics(@CurrentUser() u: Principal, @Query('assetId', ParseUUIDPipe) assetId: string) {
    const deviceIds = await this.assets.deviceIdsForAssets(u.tenantId, [assetId]);
    if (!deviceIds.length) return [];
    const { rows } = await this.tsdb.query<{ metric: string; unit: string | null }>(
      `SELECT DISTINCT ON (metric) metric, unit FROM telemetry
       WHERE tenant_id = $1 AND device_id = ANY($2::text[]) AND time > now() - INTERVAL '24 hours'
       ORDER BY metric, time DESC`,
      [u.tenantId, deviceIds],
    );
    return rows;
  }

  /** HTTP ingestion for devices that cannot speak MQTT — same pipeline as the bridge */
  @Post('telemetry/ingest')
  @HttpCode(202)
  @RequireRole('device')
  async ingest(@CurrentUser() u: Principal, @Body(new ZodPipe(IngestBody)) b: z.infer<typeof IngestBody>) {
    const now = Date.now();
    const envelope: TelemetryEnvelope = {
      schemaVersion: 1,
      messageId: randomUUID(),
      tenantId: u.tenantId,
      deviceId: b.deviceId,
      ts: b.ts ?? now,
      receivedAt: now,
      source: 'http',
      readings: b.readings,
    };
    await this.bus.publish(this.env.TOPIC_TELEMETRY_RAW, [{ key: b.deviceId, value: envelope }]);
    return { accepted: true, messageId: envelope.messageId };
  }

  /* ------------------------------- anomalies ------------------------------- */

  @Get('anomalies')
  async anomalies(@CurrentUser() u: Principal, @Query(new ZodPipe(AnomalyQuery)) q: z.infer<typeof AnomalyQuery>) {
    const { rows } = await this.tsdb.query(
      `SELECT anomaly_id AS "anomalyId", time, device_id AS "deviceId", asset_id AS "assetId", metric, value,
              detector, severity, threshold, message, acknowledged_at AS "acknowledgedAt",
              acknowledged_by AS "acknowledgedBy", resolved_at AS "resolvedAt"
       FROM anomalies
       WHERE tenant_id = $1 AND time > now() - make_interval(hours => $2)
         AND ($3::boolean IS NULL OR ($3 AND resolved_at IS NULL) OR (NOT $3 AND resolved_at IS NOT NULL))
         AND ($4::uuid IS NULL OR asset_id = $4::uuid)
         AND ($5::text IS NULL OR severity = $5)
       ORDER BY time DESC LIMIT $6`,
      [u.tenantId, q.hours, q.open === undefined ? null : q.open === 'true', q.assetId ?? null, q.severity ?? null, q.limit],
    );
    return rows;
  }

  @Get('anomalies/stats')
  async anomalyStats(@CurrentUser() u: Principal) {
    const { rows } = await this.tsdb.query(
      `SELECT severity, count(*)::int AS total,
              count(*) FILTER (WHERE resolved_at IS NULL)::int AS open,
              count(*) FILTER (WHERE acknowledged_at IS NULL AND resolved_at IS NULL)::int AS unacknowledged
       FROM anomalies WHERE tenant_id = $1 AND time > now() - INTERVAL '24 hours' GROUP BY severity`,
      [u.tenantId],
    );
    return rows;
  }

  @Post('anomalies/:id/ack')
  @HttpCode(200)
  @RequireRole('operator')
  async acknowledge(@CurrentUser() u: Principal, @Param('id', ParseUUIDPipe) id: string) {
    const res = await this.tsdb.query(
      `UPDATE anomalies SET acknowledged_at = now(), acknowledged_by = $3
       WHERE tenant_id = $1 AND anomaly_id = $2 AND acknowledged_at IS NULL`,
      [u.tenantId, id, u.sub],
    );
    if (!res.rowCount) throw new NotFoundException(`open anomaly ${id} not found`);
    return { acknowledged: true };
  }
}

@Module({ imports: [AssetsModule], controllers: [TelemetryController] })
export class TelemetryModule {}
