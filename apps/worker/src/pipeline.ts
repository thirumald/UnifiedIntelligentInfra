import type { Logger } from '@dt/common';
import {
  RedisChannels,
  TelemetryEnvelope,
  type AnomalyEvent,
  type DeviceStateSnapshot,
  type MetricValue,
} from '@dt/contracts';
import type { Pool } from '@dt/db';
import type { Redis } from 'ioredis';
import type { Producer } from 'kafkajs';
import type { AnomalyDetector } from './detector';
import type { Registry } from './registry';

const QUALITY: Record<string, number> = { good: 0, uncertain: 1, bad: 2 };

/** Column-oriented buffers → a single INSERT … SELECT unnest(...) per batch */
class TelemetryRows {
  time: Date[] = [];
  tenant: string[] = [];
  device: string[] = [];
  asset: (string | null)[] = [];
  metric: string[] = [];
  num: (number | null)[] = [];
  bool: (boolean | null)[] = [];
  text: (string | null)[] = [];
  unit: (string | null)[] = [];
  quality: number[] = [];
  messageId: string[] = [];
  receivedAt: Date[] = [];

  get length(): number {
    return this.time.length;
  }
}

export interface PipelineTopics {
  anomalies: string;
  state: string;
  dlq: string;
}

export interface RawMessage {
  key: Buffer | null;
  value: Buffer | null;
  offset: string;
}

export interface BatchResult {
  rows: number;
  anomalies: number;
  invalid: number;
}

/**
 * Processes one Kafka batch end to end:
 *   validate → enrich (asset binding) → detect → persist → fan-out.
 * Persistence happens before offsets are committed (at-least-once);
 * the telemetry unique index makes redelivery idempotent.
 */
export class TelemetryPipeline {
  /** Merged latest metrics per device (survives across batches) */
  private readonly latest = new Map<string, DeviceStateSnapshot>();

  constructor(
    private readonly deps: {
      tsdb: Pool;
      redis: Redis;
      producer: Producer;
      registry: Registry;
      detector: AnomalyDetector;
      log: Logger;
      topics: PipelineTopics;
      statePrefix: string;
    },
  ) {}

  async processBatch(messages: RawMessage[]): Promise<BatchResult> {
    const { registry, detector, log } = this.deps;
    const rows = new TelemetryRows();
    const opened: AnomalyEvent[] = [];
    const resolved: string[] = [];
    const dlq: { key: Buffer | null; value: string }[] = [];
    const touched = new Set<string>();

    for (const msg of messages) {
      let env: TelemetryEnvelope;
      try {
        env = TelemetryEnvelope.parse(JSON.parse(msg.value?.toString('utf8') ?? 'null'));
      } catch (err) {
        dlq.push({
          key: msg.key,
          value: JSON.stringify({
            reason: 'schema_validation',
            error: (err as Error).message.slice(0, 2000),
            offset: msg.offset,
            payload: msg.value?.toString('utf8').slice(0, 10_000) ?? null,
            ts: Date.now(),
          }),
        });
        continue;
      }

      const ctx = registry.context(env.tenantId, env.deviceId);
      const key = `${env.tenantId}|${env.deviceId}`;
      let snap = this.latest.get(key);
      if (!snap) {
        snap = { tenantId: env.tenantId, deviceId: env.deviceId, assetId: ctx.assetId, ts: 0, metrics: {}, status: 'normal', activeAnomalies: [] };
        this.latest.set(key, snap);
      }
      snap.assetId = ctx.assetId; // bindings can change at runtime
      // Only strictly newer readings drive detection: Kafka redelivery and
      // late/out-of-order data are persisted but cannot re-open anomalies.
      const fresh = env.ts > snap.ts;

      for (const r of env.readings) {
        rows.time.push(new Date(env.ts));
        rows.tenant.push(env.tenantId);
        rows.device.push(env.deviceId);
        rows.asset.push(ctx.assetId);
        rows.metric.push(r.metric);
        rows.num.push(typeof r.value === 'number' ? r.value : null);
        rows.bool.push(typeof r.value === 'boolean' ? r.value : null);
        rows.text.push(typeof r.value === 'string' ? r.value : null);
        rows.unit.push(r.unit ?? null);
        rows.quality.push(QUALITY[r.quality] ?? 0);
        rows.messageId.push(env.messageId);
        rows.receivedAt.push(new Date(env.receivedAt));

        // Out-of-order readings update history but never roll back live state
        if (env.ts >= snap.ts) (snap.metrics as Record<string, MetricValue>)[r.metric] = r.value;

        const numeric = typeof r.value === 'number' ? r.value : typeof r.value === 'boolean' ? (r.value ? 1 : 0) : null;
        if (fresh && numeric !== null && r.quality !== 'bad') {
          const ev = detector.evaluate(ctx, r.metric, numeric, env.ts);
          opened.push(...ev.opened);
          resolved.push(...ev.resolvedIds);
        }
      }
      snap.ts = Math.max(snap.ts, env.ts);
      touched.add(key);
    }

    // ---- 1. Persist (must succeed before offsets commit) -------------------
    if (rows.length) await this.insertTelemetry(rows);
    if (opened.length) await this.insertAnomalies(opened);
    if (resolved.length) await this.resolveAnomalies(resolved);

    // ---- 2. Live state + fan-out ------------------------------------------
    const states: DeviceStateSnapshot[] = [];
    for (const key of touched) {
      const snap = this.latest.get(key)!;
      const s = detector.deviceStatus(snap.tenantId, snap.deviceId);
      snap.status = s.status;
      snap.activeAnomalies = s.active;
      states.push({ ...snap, metrics: { ...snap.metrics } });
    }
    await this.publish(states, opened);

    if (dlq.length) {
      await this.deps.producer.send({ topic: this.deps.topics.dlq, messages: dlq });
      log.warn({ count: dlq.length }, 'invalid telemetry routed to DLQ');
    }
    return { rows: rows.length, anomalies: opened.length, invalid: dlq.length };
  }

  /** Mark a device offline (called by the stale monitor) */
  async markOffline(tenantId: string, deviceId: string, resolvedIds: string[]): Promise<void> {
    const key = `${tenantId}|${deviceId}`;
    const snap = this.latest.get(key);
    if (!snap || snap.status === 'offline') return;
    snap.status = 'offline';
    snap.activeAnomalies = [];
    if (resolvedIds.length) await this.resolveAnomalies(resolvedIds);
    await this.publish([{ ...snap }], []);
  }

  /** Devices whose last reading is older than staleAfterMs */
  staleDevices(staleAfterMs: number, now = Date.now()): { tenantId: string; deviceId: string }[] {
    const out: { tenantId: string; deviceId: string }[] = [];
    for (const s of this.latest.values()) {
      if (s.status !== 'offline' && now - s.ts > staleAfterMs) out.push({ tenantId: s.tenantId, deviceId: s.deviceId });
    }
    return out;
  }

  private async insertTelemetry(r: TelemetryRows): Promise<void> {
    await this.deps.tsdb.query(
      `INSERT INTO telemetry (time, tenant_id, device_id, asset_id, metric, value_num, value_bool, value_text, unit, quality, message_id, received_at)
       SELECT * FROM unnest($1::timestamptz[], $2::text[], $3::text[], $4::uuid[], $5::text[], $6::float8[],
                            $7::boolean[], $8::text[], $9::text[], $10::int2[], $11::uuid[], $12::timestamptz[])
       ON CONFLICT DO NOTHING`,
      [r.time, r.tenant, r.device, r.asset, r.metric, r.num, r.bool, r.text, r.unit, r.quality, r.messageId, r.receivedAt],
    );
  }

  private async insertAnomalies(events: AnomalyEvent[]): Promise<void> {
    await this.deps.tsdb.query(
      `INSERT INTO anomalies (time, anomaly_id, tenant_id, device_id, asset_id, metric, value, detector, severity, threshold, message)
       SELECT * FROM unnest($1::timestamptz[], $2::uuid[], $3::text[], $4::text[], $5::uuid[], $6::text[], $7::float8[],
                            $8::text[], $9::text[], $10::float8[], $11::text[])
       ON CONFLICT DO NOTHING`,
      [
        events.map((e) => new Date(e.ts)),
        events.map((e) => e.anomalyId),
        events.map((e) => e.tenantId),
        events.map((e) => e.deviceId),
        events.map((e) => e.assetId),
        events.map((e) => e.metric),
        events.map((e) => e.value),
        events.map((e) => e.detector),
        events.map((e) => e.severity),
        events.map((e) => e.threshold),
        events.map((e) => e.message),
      ],
    );
  }

  private async resolveAnomalies(ids: string[]): Promise<void> {
    await this.deps.tsdb.query(
      `UPDATE anomalies SET resolved_at = now()
       WHERE anomaly_id = ANY($1::uuid[]) AND resolved_at IS NULL AND time > now() - INTERVAL '30 days'`,
      [ids],
    );
  }

  private async publish(states: DeviceStateSnapshot[], anomalies: AnomalyEvent[]): Promise<void> {
    const { redis, producer, topics, statePrefix } = this.deps;
    if (!states.length && !anomalies.length) return;

    const pipe = redis.pipeline();
    for (const s of states) {
      const json = JSON.stringify(s);
      pipe.hset(RedisChannels.latestHash(s.tenantId), s.deviceId, json);
      pipe.publish(RedisChannels.state(s.tenantId, statePrefix), json);
    }
    for (const a of anomalies) pipe.publish(RedisChannels.anomaly(a.tenantId, statePrefix), JSON.stringify(a));
    await pipe.exec();

    const batch: { topic: string; messages: { key: string; value: string }[] }[] = [];
    if (states.length) batch.push({ topic: topics.state, messages: states.map((s) => ({ key: `${s.tenantId}:${s.deviceId}`, value: JSON.stringify(s) })) });
    if (anomalies.length) batch.push({ topic: topics.anomalies, messages: anomalies.map((a) => ({ key: a.deviceId, value: JSON.stringify(a) })) });
    await producer.sendBatch({ topicMessages: batch });
  }
}
