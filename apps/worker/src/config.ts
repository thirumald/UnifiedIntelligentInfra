import { envs, kafkaEnv, loadEnv, postgisEnv, redisEnv, timescaleEnv } from '@dt/common';
import { z } from 'zod';

export const env = loadEnv(
  z.object({
    KAFKA_WORKER_GROUP_ID: envs.str('dt-telemetry-worker'),
    KAFKA_IFC_GROUP_ID: envs.str('dt-ifc-worker'),
    TOPIC_TELEMETRY_RAW: envs.str('dt.telemetry.raw'),
    TOPIC_TELEMETRY_ANOMALIES: envs.str('dt.telemetry.anomalies'),
    TOPIC_DEVICE_STATE: envs.str('dt.device.state'),
    TOPIC_TELEMETRY_DLQ: envs.str('dt.telemetry.dlq'),
    TOPIC_IFC_JOBS: envs.str('dt.ifc.jobs'),

    // Anomaly detection
    ANOMALY_DEFAULT_TEMP_MAX_C: envs.num(27),
    ANOMALY_DEFAULT_RACK_POWER_MAX_KW: envs.num(8),
    ANOMALY_ZSCORE_THRESHOLD: envs.num(3.5),
    ANOMALY_WINDOW_SIZE: envs.int(60),
    /** Device considered offline after this many ms without telemetry */
    STALE_AFTER_MS: envs.int(60_000),
    REGISTRY_REFRESH_MS: envs.int(30_000),
    IFC_PARSER_ENABLED: envs.bool(true),

    ...postgisEnv,
    ...timescaleEnv,
    ...kafkaEnv,
    ...redisEnv,
  }),
);

export type WorkerEnv = typeof env;
