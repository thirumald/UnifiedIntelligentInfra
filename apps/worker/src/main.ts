/**
 * dt-platform telemetry worker
 *
 *  dt.telemetry.raw ──► [validate → enrich → detect] ──► TimescaleDB (telemetry, anomalies)
 *                                                    ├─► Redis HSET dt:latest:{tenant} + PUBLISH dt:state:{tenant}
 *                                                    ├─► Kafka dt.device.state (compacted) / dt.telemetry.anomalies
 *                                                    └─► Kafka dt.telemetry.dlq (schema failures)
 *  dt.ifc.jobs      ──► IFC parser (web-ifc) ──► PostGIS bim_elements / bim_models
 *
 * Run N replicas in the same consumer group (N ≤ partitions). Messages are
 * keyed by deviceId, so each device's detector state lives on one replica.
 */
import { createLogger, onShutdown, retry, kafkaLogCreator } from '@dt/common';
import { createPostgisPool, createTimescalePool } from '@dt/db';
import { Redis } from 'ioredis';
import { Kafka, logLevel, Partitioners } from 'kafkajs';
import { env } from './config';
import { AnomalyDetector } from './detector';
import { IfcJob, IfcParser } from './ifc';
import { TelemetryPipeline } from './pipeline';
import { Registry } from './registry';

const log = createLogger('worker');

async function main(): Promise<void> {
  const postgis = createPostgisPool(env, 'worker', (err) => log.error({ err }, 'postgis pool error'));
  const tsdb = createTimescalePool(env, 'worker', (err) => log.error({ err }, 'timescale pool error'));
  const redis = new Redis(env.REDIS_URL, { password: env.REDIS_PASSWORD || undefined, connectionName: 'dt-worker', maxRetriesPerRequest: 5 });
  redis.on('error', (err: Error) => log.warn({ err: err.message }, 'redis error'));

  const kafka = new Kafka({
    clientId: `${env.KAFKA_CLIENT_ID}-worker`,
    brokers: env.KAFKA_BROKERS,
    logLevel: logLevel.WARN,
      logCreator: kafkaLogCreator(log),
    retry: { retries: 10, initialRetryTime: 300 },
  });
  const producer = kafka.producer({ createPartitioner: Partitioners.DefaultPartitioner, allowAutoTopicCreation: false });
  const consumer = kafka.consumer({
    groupId: env.KAFKA_WORKER_GROUP_ID,
    sessionTimeout: 30_000,
    heartbeatInterval: 3_000,
    maxBytesPerPartition: 1_048_576,
  });

  await retry(() => postgis.query('SELECT 1'), { logger: log, label: 'postgis connect' });
  await retry(() => tsdb.query('SELECT 1'), { logger: log, label: 'timescale connect' });
  await retry(() => producer.connect(), { logger: log, label: 'kafka producer connect' });
  await retry(() => consumer.connect(), { logger: log, label: 'kafka consumer connect' });

  const registry = new Registry(postgis, log, { tempMaxC: env.ANOMALY_DEFAULT_TEMP_MAX_C, rackPowerMaxKw: env.ANOMALY_DEFAULT_RACK_POWER_MAX_KW });
  await retry(() => registry.start(env.REGISTRY_REFRESH_MS), { logger: log, label: 'registry load' });

  const detector = new AnomalyDetector({ zScoreThreshold: env.ANOMALY_ZSCORE_THRESHOLD, windowSize: env.ANOMALY_WINDOW_SIZE }, registry.rule);
  const pipeline = new TelemetryPipeline({
    tsdb,
    redis,
    producer,
    registry,
    detector,
    log,
    topics: { anomalies: env.TOPIC_TELEMETRY_ANOMALIES, state: env.TOPIC_DEVICE_STATE, dlq: env.TOPIC_TELEMETRY_DLQ },
    statePrefix: env.REDIS_STATE_CHANNEL_PREFIX,
  });

  // ---- Telemetry consumer ----------------------------------------------------
  let processed = 0;
  let anomalies = 0;
  await consumer.subscribe({ topic: env.TOPIC_TELEMETRY_RAW, fromBeginning: false });
  await consumer.run({
    autoCommit: true,
    eachBatchAutoResolve: false,
    partitionsConsumedConcurrently: 3,
    eachBatch: async ({ batch, resolveOffset, heartbeat, isRunning, isStale }) => {
      if (!isRunning() || isStale() || batch.messages.length === 0) return;
      // On failure the batch is retried by kafkajs (offsets not resolved) — at-least-once
      const result = await pipeline.processBatch(batch.messages);
      resolveOffset(batch.lastOffset());
      await heartbeat();
      processed += result.rows;
      anomalies += result.anomalies;
    },
  });

  // ---- Offline / stale-device monitor -----------------------------------------
  const staleTimer = setInterval(() => {
    for (const d of pipeline.staleDevices(env.STALE_AFTER_MS)) {
      const ids = detector.resetDevice(d.tenantId, d.deviceId);
      pipeline.markOffline(d.tenantId, d.deviceId, ids).catch((err: Error) => log.warn({ err: err.message }, 'offline publish failed'));
      log.info(d, 'device marked offline');
    }
  }, Math.max(5_000, Math.floor(env.STALE_AFTER_MS / 4)));

  const statsTimer = setInterval(() => {
    if (processed || anomalies) log.info({ readings: processed, anomalies }, 'throughput (last 60s)');
    processed = 0;
    anomalies = 0;
  }, 60_000);

  // ---- IFC parsing consumer ---------------------------------------------------
  const ifcConsumer = env.IFC_PARSER_ENABLED ? kafka.consumer({ groupId: env.KAFKA_IFC_GROUP_ID, sessionTimeout: 120_000 }) : null;
  if (ifcConsumer) {
    const parser = new IfcParser(postgis, log);
    await retry(() => ifcConsumer.connect(), { logger: log, label: 'kafka ifc consumer connect' });
    await ifcConsumer.subscribe({ topic: env.TOPIC_IFC_JOBS, fromBeginning: false });
    await ifcConsumer.run({
      eachMessage: async ({ message, heartbeat }) => {
        const parsed = IfcJob.safeParse(JSON.parse(message.value?.toString('utf8') ?? 'null'));
        if (!parsed.success) {
          log.warn({ err: parsed.error.message }, 'invalid IFC job skipped');
          return;
        }
        const beat = setInterval(() => void heartbeat().catch(() => undefined), 5_000);
        try {
          await parser.handle(parsed.data);
        } finally {
          clearInterval(beat);
        }
      },
    });
  }

  log.info({ group: env.KAFKA_WORKER_GROUP_ID, topic: env.TOPIC_TELEMETRY_RAW, ifc: !!ifcConsumer }, 'worker running');

  onShutdown(log, [
    () => tsdb.end(),
    () => postgis.end(),
    () => redis.quit(),
    () => producer.disconnect(),
    () => registry.stop(),
    () => clearInterval(staleTimer),
    () => clearInterval(statsTimer),
    () => ifcConsumer?.disconnect(),
    () => consumer.disconnect(),
  ]);
}

main().catch((err: Error) => {
  log.fatal({ err: err.message, stack: err.stack }, 'worker crashed');
  process.exit(1);
});
