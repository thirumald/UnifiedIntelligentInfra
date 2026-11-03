import {
  DeviceTelemetryPayload,
  SchemaMapping,
  applySchemaMapping,
  type MqttChannel,
  type Reading,
  type TelemetryEnvelope,
} from '@dt/contracts';
import { randomUUID } from 'node:crypto';

export interface Binding {
  schemaMapping: SchemaMapping | null;
}

export type NormalizeResult =
  | { ok: true; envelope: TelemetryEnvelope; unmapped: string[] }
  | { ok: false; reason: string; detail?: string };

const MAX_FUTURE_SKEW_MS = 5 * 60_000;

function parseTs(ts: string | number | undefined): number | null {
  if (ts === undefined) return null;
  if (typeof ts === 'number') return ts < 1e12 ? Math.round(ts * 1000) : Math.round(ts); // seconds or millis
  const parsed = Date.parse(ts);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Normalise an inbound MQTT message into the canonical TelemetryEnvelope.
 *
 * Resolution order:
 *   1. Canonical payload ({ ts?, readings[] }) — accepted from any device.
 *   2. Device bound to a dynamic schema mapping — vendor payload mapped.
 *   3. Otherwise → DLQ with a reason (never silently dropped).
 */
export function normalize(
  tenantId: string,
  deviceId: string,
  channel: MqttChannel,
  raw: Buffer,
  binding: Binding | undefined,
  now = Date.now(),
): NormalizeResult {
  let payload: unknown;
  const text = raw.toString('utf8').trim();

  // status channel accepts bare "online" / "offline" for constrained devices
  if (channel === 'status' && (text === 'online' || text === 'offline')) {
    payload = { online: text === 'online' };
  } else {
    try {
      payload = JSON.parse(text);
    } catch {
      return { ok: false, reason: 'invalid_json', detail: text.slice(0, 200) };
    }
  }

  let readings: Reading[];
  let ts: number | null = null;
  let unmapped: string[] = [];

  if (channel === 'status') {
    const online = (payload as { online?: unknown })?.online;
    if (typeof online !== 'boolean') return { ok: false, reason: 'invalid_status', detail: 'expected {"online": boolean}' };
    readings = [{ metric: 'online', value: online, quality: 'good' }];
  } else {
    const canonical = DeviceTelemetryPayload.safeParse(payload);
    if (canonical.success) {
      readings = canonical.data.readings;
      ts = parseTs(canonical.data.ts);
    } else if (binding?.schemaMapping) {
      const mapped = applySchemaMapping(binding.schemaMapping, payload);
      if (!mapped.readings.length) return { ok: false, reason: 'mapping_produced_no_readings', detail: mapped.unmapped.join(',') };
      readings = mapped.readings;
      ts = mapped.ts;
      unmapped = mapped.unmapped;
    } else {
      return { ok: false, reason: 'unknown_payload_shape', detail: canonical.error.issues[0]?.message };
    }
  }

  // Reject absurd device clocks — keep receive time instead
  if (ts === null || ts > now + MAX_FUTURE_SKEW_MS || ts < now - 7 * 86_400_000) ts = now;

  return {
    ok: true,
    unmapped,
    envelope: {
      schemaVersion: 1,
      messageId: randomUUID(),
      tenantId,
      deviceId,
      ts,
      receivedAt: now,
      source: 'mqtt',
      readings,
    },
  };
}
