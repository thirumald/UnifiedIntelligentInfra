import { Body, Controller, Delete, Get, HttpCode, Module, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { AssetInput, AssetPatch, GeoJsonPoint } from '@dt/contracts';
import { z } from 'zod';
import { CurrentUser, RequireRole, type Principal } from '../auth/auth';
import { ZodPipe } from '../common/zod.pipe';
import { AssetsService } from './assets.service';

const BboxParam = z
  .string()
  .transform((s) => s.split(',').map(Number))
  .refine((a) => a.length === 4 && a.every(Number.isFinite), 'bbox must be minLon,minLat,maxLon,maxLat')
  .transform((a) => a as [number, number, number, number]);

const ListQuery = z.object({
  bbox: BboxParam.optional(),
  type: z
    .string()
    .transform((s) => s.split(',').filter(Boolean))
    .optional(),
  domain: z.string().optional(),
  q: z.string().max(100).optional(),
  modelId: z.string().uuid().optional(),
  tag: z.string().max(64).optional(),
  parentId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(5000).default(1000),
  cursor: z.string().uuid().optional(),
});

const NearbyQuery = z.object({
  lon: z.coerce.number().min(-180).max(180),
  lat: z.coerce.number().min(-90).max(90),
  radius: z.coerce.number().positive().max(50_000).default(250),
  limit: z.coerce.number().int().min(1).max(500).default(50),
});

/** Accept either a plain AssetInput or a GeoJSON Feature wrapping one. */
const FeatureInput = z
  .object({ type: z.literal('Feature'), geometry: GeoJsonPoint, properties: z.record(z.unknown()) })
  .transform((f) => ({ ...f.properties, location: f.geometry }))
  .pipe(AssetInput);
/** Picks the schema by shape so validation errors point at the real field */
const createPipe = {
  transform: (value: unknown): AssetInput =>
    (value as { type?: unknown } | null)?.type === 'Feature' ? new ZodPipe(FeatureInput).transform(value) : new ZodPipe(AssetInput).transform(value),
};

const ImportBody = z.object({
  type: z.literal('FeatureCollection'),
  features: z.array(FeatureInput).min(1).max(10_000),
});

@Controller('assets')
export class AssetsController {
  constructor(private readonly assets: AssetsService) {}

  /** GeoJSON FeatureCollection — filter by bbox, type, domain, text, BIM model, tag */
  @Get()
  list(@CurrentUser() user: Principal, @Query(new ZodPipe(ListQuery)) q: z.infer<typeof ListQuery>) {
    return this.assets.list(user.tenantId, { ...q, types: q.type });
  }

  @Get('summary')
  summary(@CurrentUser() user: Principal) {
    return this.assets.summary(user.tenantId);
  }

  /** Radius search in metres (geography distance) ordered by proximity */
  @Get('nearby')
  nearby(@CurrentUser() user: Principal, @Query(new ZodPipe(NearbyQuery)) q: z.infer<typeof NearbyQuery>) {
    return this.assets.nearby(user.tenantId, q.lon, q.lat, q.radius, q.limit);
  }

  @Get(':id')
  get(@CurrentUser() user: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.assets.get(user.tenantId, id);
  }

  @Post()
  @RequireRole('operator')
  create(@CurrentUser() user: Principal, @Body(createPipe) body: AssetInput) {
    return this.assets.create(user.tenantId, body, user.sub);
  }

  /** Bulk upsert from a GeoJSON FeatureCollection (matched on externalId) */
  @Post('import')
  @RequireRole('operator')
  import(@CurrentUser() user: Principal, @Body(new ZodPipe(ImportBody)) body: z.infer<typeof ImportBody>) {
    return this.assets.importCollection(user.tenantId, body.features, user.sub);
  }

  @Patch(':id')
  @RequireRole('operator')
  update(
    @CurrentUser() user: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(AssetPatch)) body: AssetPatch,
  ) {
    return this.assets.update(user.tenantId, id, body, user.sub);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequireRole('admin')
  async remove(@CurrentUser() user: Principal, @Param('id', ParseUUIDPipe) id: string) {
    await this.assets.remove(user.tenantId, id, user.sub);
  }
}

@Module({
  controllers: [AssetsController],
  providers: [AssetsService],
  exports: [AssetsService],
})
export class AssetsModule {}
