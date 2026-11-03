import { z } from 'zod';

/**
 * Telemetry contract.
 *
 * Devices speak heterogeneous protocols (Modbus, OPC-UA, BACnet, vendor JSON).
 * The ingest-bridge normalises everything into TelemetryEnvelope — a
 * schema-flexible shape where each reading is (metric, value, unit). New
 * metrics require no code change; per-device mapping lives in PostGIS
 * (device_schema_mappings, Phase 2).
 */

export const MetricValue = z.union([z.number().finite(), z.boolean(), z.string().max(256)]);
export type MetricValue = z.infer<typeof MetricValue>;

export const Reading = z.object({
  /** Canonical metric key, e.g. "temperature_c", "power_kw", "door_open" */
  metric: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z][a-z0-9_]*$/, 'metric must be snake_case'),
  value: MetricValue,
  unit: z.string().max(16).optional(),
  /** OPC-UA style quality flag */
  quality: z.enum(['good', 'uncertain', 'bad']).default('good'),
});
export type Reading = z.infer<typeof Reading>;

/** Payload a device (or OT gateway) publishes on dt/v1/{tenant}/{device}/telemetry */
export const DeviceTelemetryPayload = z.object({
  /** ISO-8601 or epoch millis; bridge stamps receive-time if absent */
  ts: z.union([z.string().datetime({ offset: true }), z.number().int().positive()]).optional(),
  readings: z.array(Reading).min(1).max(500),
  /** Raw vendor payload passes through for later re-mapping */
  raw: z.record(z.unknown()).optional(),
});
export type DeviceTelemetryPayload = z.infer<typeof DeviceTelemetryPayload>;

/** Normalised envelope on Kafka dt.telemetry.raw (key = deviceId) */
export const TelemetryEnvelope = z.object({
  schemaVersion: z.literal(1),
  messageId: z.string().uuid(),
  tenantId: z.string().min(1).max(64),
  deviceId: z.string().min(1).max(128),
  /** Device-reported time, epoch millis */
  ts: z.number().int().positive(),
  /** Bridge receive time, epoch millis — used for latency SLOs */
  receivedAt: z.number().int().positive(),
  source: z.enum(['mqtt', 'http', 'opcua', 'modbus', 'bacnet', 'simulator']),
  readings: z.array(Reading).min(1),
});
export type TelemetryEnvelope = z.infer<typeof TelemetryEnvelope>;

export const Severity = z.enum(['info', 'warning', 'critical']);
export type Severity = z.infer<typeof Severity>;

/** Emitted by the worker on dt.telemetry.anomalies */
export const AnomalyEvent = z.object({
  schemaVersion: z.literal(1),
  anomalyId: z.string().uuid(),
  tenantId: z.string(),
  deviceId: z.string(),
  assetId: z.string().uuid().nullable(),
  metric: z.string(),
  value: z.number(),
  ts: z.number().int(),
  detector: z.enum(['threshold', 'zscore', 'rate_of_change', 'stale']),
  severity: Severity,
  /** Bound that was breached (threshold) or z-score (statistical) */
  threshold: z.number().nullable(),
  message: z.string(),
});
export type AnomalyEvent = z.infer<typeof AnomalyEvent>;

/** Latest per-device snapshot (Redis hash + dt.device.state, compacted) */
export const DeviceStateSnapshot = z.object({
  tenantId: z.string(),
  deviceId: z.string(),
  assetId: z.string().uuid().nullable(),
  ts: z.number().int(),
  metrics: z.record(MetricValue),
  status: z.enum(['normal', 'warning', 'critical', 'offline']),
  activeAnomalies: z.array(z.string()),
});
export type DeviceStateSnapshot = z.infer<typeof DeviceStateSnapshot>;
