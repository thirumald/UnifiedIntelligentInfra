import { Inject, Module, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  type OnGatewayConnection,
} from '@nestjs/websockets';
import {
  AnomalyEvent,
  DeviceStateSnapshot,
  REALTIME_NAMESPACE,
  RedisChannels,
  type ClientToServerEvents,
  type ServerToClientEvents,
  type SocketData,
  type ViewportSubscription,
} from '@dt/contracts';
import type { Redis } from 'ioredis';
import type { Namespace, Socket } from 'socket.io';
import { z } from 'zod';
import { AssetsModule } from '../assets/assets.controller';
import { AssetsService } from '../assets/assets.service';
import { AuthModule, TokenService } from '../auth/auth';
import { API_ENV, apiEnv, type ApiEnv } from '../config';
import { REDIS, REDIS_SUB, log } from '../infra/infra.module';

type TwinSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData & { devices: Set<string> | null }>;

const STATUS_RANK: Record<DeviceStateSnapshot['status'], number> = { normal: 0, warning: 1, critical: 2, offline: 1 };
const FLUSH_INTERVAL_MS = 100; // ≤ 10 Hz per client — smooth UI without flooding

const Subscription = z.object({
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
  assetIds: z.array(z.string().uuid()).max(5000).optional(),
  minStatus: z.enum(['normal', 'warning', 'critical', 'offline']).optional(),
});

/**
 * Real-time digital-twin gateway.
 *
 * Fan-out model: the worker PUBLISHes every state change to Redis
 * (dt:state:{tenant}); each API replica PSUBSCRIBEs and pushes only to its
 * own connected sockets. Replicas are therefore independent — scale
 * horizontally behind the Gravitee gateway (enable sticky sessions if
 * clients fall back to long-polling).
 *
 * Per-socket viewport filtering (bbox / asset list) keeps the browser from
 * receiving telemetry for objects it is not rendering.
 */
@WebSocketGateway({
  namespace: REALTIME_NAMESPACE,
  path: apiEnv().WS_PATH,
  cors: { origin: apiEnv().CORS_ORIGINS, credentials: true },
  pingInterval: 20_000,
  pingTimeout: 20_000,
  maxHttpBufferSize: 64 * 1024,
})
export class TwinGateway implements OnGatewayConnection, OnModuleInit, OnModuleDestroy {
  @WebSocketServer() private readonly ns!: Namespace<ClientToServerEvents, ServerToClientEvents>;

  /** tenant → (deviceId → latest snapshot) pending flush */
  private readonly pending = new Map<string, Map<string, DeviceStateSnapshot>>();
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(REDIS_SUB) private readonly sub: Redis,
    @Inject(API_ENV) private readonly env: ApiEnv,
    private readonly tokens: TokenService,
    private readonly assets: AssetsService,
  ) {}

  async onModuleInit(): Promise<void> {
    const prefix = this.env.REDIS_STATE_CHANNEL_PREFIX;
    this.sub.on('pmessage', (_pattern: string, channel: string, message: string) => this.onRedisMessage(prefix, channel, message));
    await this.sub.psubscribe(`${prefix}:*`);
    this.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
    log.info({ pattern: `${prefix}:*`, path: this.env.WS_PATH }, 'realtime gateway subscribed');
  }

  async onModuleDestroy(): Promise<void> {
    if (this.flushTimer) clearInterval(this.flushTimer);
    await this.sub.punsubscribe().catch(() => undefined);
  }

  /** Authenticate during the handshake; reject before any data flows. */
  handleConnection(socket: TwinSocket): void {
    try {
      let principal;
      if (this.tokens.disabled) {
        principal = this.tokens.anonymous();
      } else {
        const auth = socket.handshake.auth as { token?: string } | undefined;
        const token = auth?.token ?? (socket.handshake.query.token as string | undefined);
        if (!token) throw new Error('missing token');
        principal = this.tokens.verify(token);
      }
      socket.data.tenantId = principal.tenantId;
      socket.data.userId = principal.sub;
      socket.data.subscription = null;
      socket.data.devices = null;
      void socket.join(`tenant:${principal.tenantId}`);
    } catch (err) {
      socket.emit('server:error', { code: 'unauthorized', message: (err as Error).message });
      socket.disconnect(true);
    }
  }

  @SubscribeMessage('subscribe')
  async subscribe(@ConnectedSocket() socket: TwinSocket, @MessageBody() body: ViewportSubscription) {
    const parsed = Subscription.safeParse(body ?? {});
    if (!parsed.success) {
      socket.emit('server:error', { code: 'bad_subscription', message: parsed.error.message });
      return { ok: false, devices: 0 };
    }
    const sub = parsed.data;
    const tenantId = socket.data.tenantId;

    let devices: Set<string> | null = null;
    if (sub.assetIds?.length) devices = new Set(await this.assets.deviceIdsForAssets(tenantId, sub.assetIds));
    if (sub.bbox) {
      const inBox = await this.assets.deviceIdsInBbox(tenantId, sub.bbox);
      devices = devices ? new Set(inBox.filter((d) => devices!.has(d))) : new Set(inBox);
    }
    socket.data.subscription = sub;
    socket.data.devices = devices;

    // Rehydrate: send the current snapshot so the scene is correct immediately
    const all = await this.redis.hgetall(RedisChannels.latestHash(tenantId));
    const snapshot: DeviceStateSnapshot[] = [];
    for (const [deviceId, json] of Object.entries(all)) {
      if (devices && !devices.has(deviceId)) continue;
      const s = DeviceStateSnapshot.safeParse(JSON.parse(json));
      if (s.success && this.passesStatus(s.data, sub)) snapshot.push(s.data);
    }
    socket.emit('state:snapshot', snapshot);
    return { ok: true, devices: devices ? devices.size : snapshot.length };
  }

  @SubscribeMessage('unsubscribe')
  unsubscribe(@ConnectedSocket() socket: TwinSocket) {
    socket.data.subscription = null;
    socket.data.devices = new Set();
  }

  private passesStatus(s: DeviceStateSnapshot, sub: ViewportSubscription | null): boolean {
    if (!sub?.minStatus) return true;
    return STATUS_RANK[s.status] >= STATUS_RANK[sub.minStatus];
  }

  private onRedisMessage(prefix: string, channel: string, message: string): void {
    // channel = {prefix}:{tenant}  |  {prefix}:{tenant}:anomaly
    const rest = channel.slice(prefix.length + 1);
    const isAnomaly = rest.endsWith(':anomaly');
    const tenantId = isAnomaly ? rest.slice(0, -':anomaly'.length) : rest;
    try {
      const payload: unknown = JSON.parse(message);
      if (isAnomaly) {
        const event = AnomalyEvent.parse(payload);
        // Anomalies bypass coalescing — operators need them immediately
        for (const socket of this.tenantSockets(tenantId)) {
          if (!socket.data.subscription) continue;
          const devs = socket.data.devices;
          if (!devs || devs.has(event.deviceId)) socket.emit('anomaly', event);
        }
        return;
      }
      const state = DeviceStateSnapshot.parse(payload);
      let bucket = this.pending.get(tenantId);
      if (!bucket) this.pending.set(tenantId, (bucket = new Map()));
      bucket.set(state.deviceId, state); // keep only latest per device within the window
    } catch (err) {
      log.warn({ channel, err: (err as Error).message }, 'dropping malformed realtime message');
    }
  }

  private *tenantSockets(tenantId: string): Iterable<TwinSocket> {
    for (const socket of this.ns.sockets.values() as Iterable<TwinSocket>) {
      if (socket.data.tenantId === tenantId) yield socket;
    }
  }

  private flush(): void {
    if (this.pending.size === 0) return;
    const batches = new Map(this.pending);
    this.pending.clear();
    for (const [tenantId, states] of batches) {
      const all = [...states.values()];
      for (const socket of this.tenantSockets(tenantId)) {
        const sub = socket.data.subscription;
        if (!sub) continue;
        const devs = socket.data.devices;
        const out = all.filter((s) => (!devs || devs.has(s.deviceId)) && this.passesStatus(s, sub));
        if (out.length) socket.emit('state:batch', out);
      }
    }
  }
}

@Module({ imports: [AuthModule, AssetsModule], providers: [TwinGateway] })
export class RealtimeModule {}
