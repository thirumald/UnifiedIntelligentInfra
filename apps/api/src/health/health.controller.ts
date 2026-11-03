import { Controller, Get, Inject, Module, ServiceUnavailableException } from '@nestjs/common';
import { ping, type Pool } from '@dt/db';
import type { Redis } from 'ioredis';
import { Public } from '../auth/auth';
import { EventBus, POSTGIS, REDIS, TSDB } from '../infra/infra.module';

@Controller('health')
export class HealthController {
  constructor(
    @Inject(POSTGIS) private readonly postgis: Pool,
    @Inject(TSDB) private readonly tsdb: Pool,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly bus: EventBus,
  ) {}

  /** Process is up — used by the container healthcheck */
  @Public()
  @Get('live')
  live() {
    return { status: 'ok', uptimeS: Math.round(process.uptime()) };
  }

  /** All dependencies reachable — used by gateways / orchestrators */
  @Public()
  @Get('ready')
  async ready() {
    const [postgis, timescale, redis] = await Promise.all([
      ping(this.postgis),
      ping(this.tsdb),
      this.redis
        .ping()
        .then((r) => r === 'PONG')
        .catch(() => false),
    ]);
    const checks = { postgis, timescale, redis, kafka: this.bus.isConnected };
    const ok = Object.values(checks).every(Boolean);
    if (!ok) throw new ServiceUnavailableException({ status: 'degraded', checks });
    return { status: 'ok', checks };
  }
}

@Module({ controllers: [HealthController] })
export class HealthModule {}
