/**
 * Kafka topic names and MQTT topic contract — the single source of truth.
 * Values mirror infra/kafka/create-topics.sh and .env.example defaults;
 * services read the env override first and fall back to these.
 */
export const KafkaTopics = {
  TelemetryRaw: 'dt.telemetry.raw',
  TelemetryAnomalies: 'dt.telemetry.anomalies',
  DeviceState: 'dt.device.state',
  AssetEvents: 'dt.asset.events',
  IfcJobs: 'dt.ifc.jobs',
  TelemetryDlq: 'dt.telemetry.dlq',
} as const;

export type KafkaTopic = (typeof KafkaTopics)[keyof typeof KafkaTopics];

/** Resolve a topic name honouring the TOPIC_* env overrides. */
export function topic(key: keyof typeof KafkaTopics, env: NodeJS.ProcessEnv = process.env): string {
  const envKey = `TOPIC_${key.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase()}`;
  return env[envKey] ?? KafkaTopics[key];
}

/** MQTT topic layout: dt/v1/{tenantId}/{deviceId}/{channel} */
export const MqttChannels = ['telemetry', 'status', 'cmd'] as const;
export type MqttChannel = (typeof MqttChannels)[number];

export const MQTT_ROOT = 'dt/v1';

export function mqttTopic(tenantId: string, deviceId: string, channel: MqttChannel, root = MQTT_ROOT): string {
  return `${root}/${tenantId}/${deviceId}/${channel}`;
}

/** Parse an inbound MQTT topic; returns null if it does not match the contract. */
export function parseMqttTopic(
  t: string,
  root = MQTT_ROOT,
): { tenantId: string; deviceId: string; channel: MqttChannel } | null {
  if (!t.startsWith(`${root}/`)) return null;
  const parts = t.slice(root.length + 1).split('/');
  if (parts.length !== 3) return null;
  const [tenantId, deviceId, channel] = parts as [string, string, string];
  if (!tenantId || !deviceId || !(MqttChannels as readonly string[]).includes(channel)) return null;
  return { tenantId, deviceId, channel: channel as MqttChannel };
}

/** Redis pub/sub channels used for WebSocket fan-out (worker → api). */
export const RedisChannels = {
  /** dt:state:{tenantId} — every device state change for a tenant */
  state: (tenantId: string, prefix = 'dt:state') => `${prefix}:${tenantId}`,
  /** dt:state:{tenantId}:anomaly — anomalies only (higher priority) */
  anomaly: (tenantId: string, prefix = 'dt:state') => `${prefix}:${tenantId}:anomaly`,
  /** Hash holding the latest snapshot per device — rehydrates new WS clients */
  latestHash: (tenantId: string) => `dt:latest:${tenantId}`,
} as const;
