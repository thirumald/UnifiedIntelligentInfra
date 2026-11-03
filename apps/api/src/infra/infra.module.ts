import { Global, Inject, Injectable, Module, ServiceUnavailableException, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { createLogger, retry, type Logger, kafkaLogCreator } from '@dt/common';
import { createPostgisPool, createTimescalePool, type Pool } from '@dt/db';
import { Redis } from 'ioredis';
import { Kafka, logLevel, Partitioners, type Producer } from 'kafkajs';
import { API_ENV, apiEnv, type ApiEnv } from '../config';

export const POSTGIS = Symbol('POSTGIS');
export const TSDB = Symbol('TSDB');
export const REDIS = Symbol('REDIS');
export const REDIS_SUB = Symbol('REDIS_SUB');

export const log: Logger = createLogger('api');

/**
 * Kafka producer wrapper. Connects in the background with retry so the API
 * still serves spatial reads while the broker is unavailable; readiness
 * reports the broker state.
 */
@Injectable()
export class EventBus implements OnModuleInit, OnApplicationShutdown {
  private readonly producer: Producer;
  private connected = false;

  constructor(@Inject(API_ENV) env: ApiEnv) {
    const kafka = new Kafka({
      clientId: `${env.KAFKA_CLIENT_ID}-api`,
      brokers: env.KAFKA_BROKERS,
      logLevel: logLevel.WARN,
      logCreator: kafkaLogCreator(log),
    });
    this.producer = kafka.producer({
      idempotent: true,
      maxInFlightRequests: 1,
      createPartitioner: Partitioners.DefaultPartitioner,
    });
    this.producer.on(this.producer.events.DISCONNECT, () => {
      this.connected = false;
    });
  }

  onModuleInit(): void {
    void retry(
      async () => {
        await this.producer.connect();
        this.connected = true;
        log.info('kafka producer connected');
      },
      { logger: log, label: 'kafka connect', retries: 1_000, maxMs: 15_000 },
    );
  }

  get isConnected(): boolean {
    return this.connected;
  }

  /** Publish JSON messages keyed for partition affinity. */
  async publish(topic: string, messages: { key: string; value: unknown }[]): Promise<void> {
    if (!this.connected) throw new ServiceUnavailableException('event bus unavailable — retry shortly');
    await this.producer.send({
      topic,
      messages: messages.map((m) => ({ key: m.key, value: JSON.stringify(m.value) })),
    });
  }

  /** Fire-and-log variant for non-critical audit events. */
  publishSafe(topic: string, messages: { key: string; value: unknown }[]): void {
    this.publish(topic, messages).catch((err: Error) => log.warn({ topic, err: err.message }, 'event publish failed'));
  }

  async onApplicationShutdown(): Promise<void> {
    await this.producer.disconnect().catch(() => undefined);
  }
}

@Injectable()
class InfraLifecycle implements OnApplicationShutdown {
  constructor(
    @Inject(POSTGIS) private readonly postgis: Pool,
    @Inject(TSDB) private readonly tsdb: Pool,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(REDIS_SUB) private readonly redisSub: Redis,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled([this.postgis.end(), this.tsdb.end(), this.redis.quit(), this.redisSub.quit()]);
  }
}

function redisClient(env: ApiEnv, name: string): Redis {
  const client = new Redis(env.REDIS_URL, {
    password: env.REDIS_PASSWORD || undefined,
    connectionName: `dt-api-${name}`,
    maxRetriesPerRequest: 3,
    enableAutoPipelining: true,
  });
  client.on('error', (err: Error) => log.warn({ err: err.message, client: name }, 'redis error'));
  return client;
}

@Global()
@Module({
  providers: [
    { provide: API_ENV, useFactory: apiEnv },
    {
      provide: POSTGIS,
      inject: [API_ENV],
      useFactory: (env: ApiEnv) => createPostgisPool(env, 'api', (err) => log.error({ err }, 'postgis pool error')),
    },
    {
      provide: TSDB,
      inject: [API_ENV],
      useFactory: (env: ApiEnv) => createTimescalePool(env, 'api', (err) => log.error({ err }, 'timescale pool error')),
    },
    { provide: REDIS, inject: [API_ENV], useFactory: (env: ApiEnv) => redisClient(env, 'cmd') },
    // Dedicated connection: a subscribed Redis client cannot issue other commands
    { provide: REDIS_SUB, inject: [API_ENV], useFactory: (env: ApiEnv) => redisClient(env, 'sub') },
    EventBus,
    InfraLifecycle,
  ],
  exports: [API_ENV, POSTGIS, TSDB, REDIS, REDIS_SUB, EventBus],
})
export class InfraModule {}
