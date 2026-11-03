/**
 * MQTT → Kafka ingest bridge
 *
 *  dt/v1/{tenant}/{device}/telemetry|status  (QoS 1)
 *        │  normalise (canonical payload or dynamic schema mapping)
 *        ▼
 *  Kafka dt.telemetry.raw   key = deviceId (per-device ordering)
 *  Kafka dt.telemetry.dlq   anything that cannot be normalised
 *
 * Delivery: MQTT PUBACKs are withheld until the Kafka write succeeds
 * (customHandleAcks), giving end-to-end at-least-once from device to log.
 */
import { createLogger, envs, kafkaEnv, loadEnv, onShutdown, postgisEnv, retry, kafkaLogCreator } from '@dt/common';
import { MQTT_ROOT, SchemaMapping, parseMqttTopic } from '@dt/contracts';
import { createPostgisPool } from '@dt/db';
import { Kafka, logLevel, Partitioners, type Message } from 'kafkajs';
import mqtt from 'mqtt';
import { z } from 'zod';
import { normalize, type Binding } from './normalize';

const env = loadEnv(
  z.object({
    MQTT_URL: envs.str('mqtt://mosquitto:1883'),
    MQTT_SERVICE_USERNAME: envs.str('dt-service'),
    MQTT_SERVICE_PASSWORD: envs.str(),
    MQTT_TOPIC_ROOT: envs.str(MQTT_ROOT),
    /** Set to enable MQTT shared subscriptions across bridge replicas */
    MQTT_SHARED_GROUP: z.string().optional(),
    TOPIC_TELEMETRY_RAW: envs.str('dt.telemetry.raw'),
    TOPIC_TELEMETRY_DLQ: envs.str('dt.telemetry.dlq'),
    BRIDGE_FLUSH_MS: envs.int(50),
    BRIDGE_MAX_BATCH: envs.int(1000),
    REGISTRY_REFRESH_MS: envs.int(30_000),
    ...kafkaEnv,
    ...postgisEnv,
  }),
);

const log = createLogger('ingest-bridge');

type Ack = (code: number) => void;
interface Pending {
  topic: string;
  message: Message;
  ack: Ack | null;
}

async function main(): Promise<void> {
  // ---- Device bindings (schema mappings) from PostGIS --------------------
  const db = createPostgisPool(env, 'ingest-bridge', (err) => log.error({ err }, 'postgis pool error'));
  let bindings = new Map<string, Binding>();
  const refresh = async () => {
    const { rows } = await db.query<{ tenant_id: string; device_id: string; schema_mapping: unknown }>(
      'SELECT tenant_id, device_id, schema_mapping FROM v_device_bindings WHERE enabled',
    );
    const next = new Map<string, Binding>();
    for (const r of rows) {
      const parsed = r.schema_mapping ? SchemaMapping.safeParse(r.schema_mapping) : null;
      if (parsed && !parsed.success) log.warn({ device: r.device_id }, 'ignoring invalid schema mapping');
      next.set(`${r.tenant_id}|${r.device_id}`, { schemaMapping: parsed?.success ? parsed.data : null });
    }
    bindings = next;
  };
  await retry(refresh, { logger: log, label: 'load device bindings' });
  const refreshTimer = setInterval(() => void refresh().catch((err: Error) => log.warn({ err: err.message }, 'binding refresh failed')), env.REGISTRY_REFRESH_MS);

  // ---- Kafka --------------------------------------------------------------
  const kafka = new Kafka({ clientId: `${env.KAFKA_CLIENT_ID}-bridge`, brokers: env.KAFKA_BROKERS, logLevel: logLevel.WARN, logCreator: kafkaLogCreator(log) });
  const producer = kafka.producer({ idempotent: true, maxInFlightRequests: 1, createPartitioner: Partitioners.DefaultPartitioner });
  await retry(() => producer.connect(), { logger: log, label: 'kafka connect' });

  let buffer: Pending[] = [];
  let flushing = false;
  let stats = { ok: 0, dlq: 0 };

  const flush = async () => {
    if (flushing || buffer.length === 0) return;
    flushing = true;
    const batch = buffer;
    buffer = [];
    try {
      const byTopic = new Map<string, Message[]>();
      for (const p of batch) {
        let list = byTopic.get(p.topic);
        if (!list) byTopic.set(p.topic, (list = []));
        list.push(p.message);
      }
      await producer.sendBatch({ topicMessages: [...byTopic].map(([topic, messages]) => ({ topic, messages })) });
      for (const p of batch) p.ack?.(0);
    } catch (err) {
      // Withhold PUBACK → broker redelivers to the next session; re-buffer for this one
      log.error({ err: (err as Error).message, size: batch.length }, 'kafka write failed — re-queueing');
      buffer = batch.concat(buffer);
    } finally {
      flushing = false;
    }
  };
  const flushTimer = setInterval(() => void flush(), env.BRIDGE_FLUSH_MS);

  // ---- MQTT ---------------------------------------------------------------
  const root = env.MQTT_TOPIC_ROOT;
  const filters = [`${root}/+/+/telemetry`, `${root}/+/+/status`].map((f) =>
    env.MQTT_SHARED_GROUP ? `$share/${env.MQTT_SHARED_GROUP}/${f}` : f,
  );

  const client = mqtt.connect(env.MQTT_URL, {
    clientId: `dt-ingest-bridge-${process.pid}-${Math.random().toString(16).slice(2, 8)}`,
    username: env.MQTT_SERVICE_USERNAME,
    password: env.MQTT_SERVICE_PASSWORD,
    protocolVersion: 5,
    clean: false,
    properties: { sessionExpiryInterval: 3600 },
    reconnectPeriod: 2_000,
    connectTimeout: 10_000,
    customHandleAcks: (topic, payload, _packet, done) => {
      const parsed = parseMqttTopic(topic, root);
      if (!parsed || parsed.channel === 'cmd') return done(0);
      const result = normalize(parsed.tenantId, parsed.deviceId, parsed.channel, payload, bindings.get(`${parsed.tenantId}|${parsed.deviceId}`));
      if (result.ok) {
        stats.ok++;
        if (result.unmapped.length) log.debug({ device: parsed.deviceId, unmapped: result.unmapped }, 'partial mapping');
        buffer.push({
          topic: env.TOPIC_TELEMETRY_RAW,
          message: { key: parsed.deviceId, value: JSON.stringify(result.envelope) },
          ack: done as Ack,
        });
      } else {
        stats.dlq++;
        buffer.push({
          topic: env.TOPIC_TELEMETRY_DLQ,
          message: {
            key: parsed.deviceId,
            value: JSON.stringify({ reason: result.reason, detail: result.detail, mqttTopic: topic, payload: payload.toString('utf8').slice(0, 10_000), ts: Date.now() }),
          },
          ack: done as Ack,
        });
      }
      if (buffer.length >= env.BRIDGE_MAX_BATCH) void flush();
    },
  });

  client.on('connect', () => {
    client.subscribe(filters, { qos: 1 }, (err) => {
      if (err) log.error({ err: err.message }, 'mqtt subscribe failed');
      else log.info({ filters }, 'mqtt subscribed');
    });
  });
  client.on('reconnect', () => log.warn('mqtt reconnecting'));
  client.on('error', (err) => log.error({ err: err.message }, 'mqtt error'));

  const statsTimer = setInterval(() => {
    if (stats.ok || stats.dlq) log.info({ ...stats, bindings: bindings.size }, 'bridge throughput (last 60s)');
    stats = { ok: 0, dlq: 0 };
  }, 60_000);

  onShutdown(log, [
    () => db.end(),
    () => producer.disconnect(),
    () => flush(),
    () => clearInterval(flushTimer),
    () => clearInterval(statsTimer),
    () => clearInterval(refreshTimer),
    () => new Promise<void>((resolve) => client.end(false, {}, () => resolve())),
  ]);
}

main().catch((err: Error) => {
  log.fatal({ err: err.message }, 'bridge crashed');
  process.exit(1);
});
