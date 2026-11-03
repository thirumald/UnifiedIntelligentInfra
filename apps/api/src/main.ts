import 'reflect-metadata';
import { Module, RequestMethod, type LoggerService } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { IoAdapter } from '@nestjs/platform-socket.io';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { AssetsModule } from './assets/assets.controller';
import { AuthModule } from './auth/auth';
import { BimModule } from './bim/bim.controller';
import { apiEnv } from './config';
import { DevicesModule } from './devices/devices.controller';
import { HealthModule } from './health/health.controller';
import { InfraModule, log } from './infra/infra.module';
import { RealtimeModule } from './realtime/twin.gateway';
import { TelemetryModule } from './telemetry/telemetry.controller';

@Module({
  imports: [InfraModule, AuthModule, AssetsModule, DevicesModule, TelemetryModule, BimModule, RealtimeModule, HealthModule],
})
class AppModule {}

/** Route Nest's framework logs through the structured pino logger */
const nestLogger: LoggerService = {
  log: (msg, ctx) => log.info({ ctx }, String(msg)),
  error: (msg, trace, ctx) => log.error({ ctx, trace }, String(msg)),
  warn: (msg, ctx) => log.warn({ ctx }, String(msg)),
  debug: (msg, ctx) => log.debug({ ctx }, String(msg)),
  verbose: (msg, ctx) => log.trace({ ctx }, String(msg)),
};

async function bootstrap(): Promise<void> {
  const env = apiEnv();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: nestLogger, bufferLogs: true });

  app.set('trust proxy', true); // behind Gravitee
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.useBodyParser('json', { limit: '10mb' }); // bulk GeoJSON imports
  app.enableCors({ origin: env.CORS_ORIGINS, credentials: true, maxAge: 600 });
  app.setGlobalPrefix(env.API_GLOBAL_PREFIX, {
    exclude: [
      { path: 'health/live', method: RequestMethod.GET },
      { path: 'health/ready', method: RequestMethod.GET },
    ],
  });
  app.useWebSocketAdapter(new IoAdapter(app));
  app.enableShutdownHooks();

  await app.listen(env.PORT, '0.0.0.0');
  log.info({ port: env.PORT, prefix: env.API_GLOBAL_PREFIX, ws: env.WS_PATH, authDisabled: env.AUTH_DISABLED }, 'api listening');
}

bootstrap().catch((err: Error) => {
  log.fatal({ err: err.message, stack: err.stack }, 'api failed to start');
  process.exit(1);
});
