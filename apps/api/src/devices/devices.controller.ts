import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Module,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { SchemaMapping, applySchemaMapping } from '@dt/contracts';
import type { Pool } from '@dt/db';
import { z } from 'zod';
import { CurrentUser, RequireRole, type Principal } from '../auth/auth';
import { ZodPipe } from '../common/zod.pipe';
import { POSTGIS } from '../infra/infra.module';

const DeviceBody = z.object({
  id: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
  assetId: z.string().uuid().nullable().default(null),
  protocol: z.string().max(32).default('mqtt'),
  schemaMappingId: z.string().uuid().nullable().default(null),
  profile: z.string().max(32).nullable().default(null),
  enabled: z.boolean().default(true),
  metadata: z.record(z.unknown()).default({}),
});

const MappingBody = z.object({
  name: z.string().min(1).max(100),
  protocol: z.enum(['json', 'bacnet', 'modbus', 'opcua', 'vendor']).default('json'),
  mapping: SchemaMapping,
});

const MappingTestBody = z.object({ mapping: SchemaMapping, payload: z.unknown() });

const RuleBody = z
  .object({
    assetId: z.string().uuid().nullable().default(null),
    assetType: z.string().max(32).nullable().default(null),
    metric: z.string().regex(/^[a-z][a-z0-9_]*$/),
    warnMin: z.number().nullable().default(null),
    warnMax: z.number().nullable().default(null),
    critMin: z.number().nullable().default(null),
    critMax: z.number().nullable().default(null),
    enabled: z.boolean().default(true),
  })
  .refine((r) => r.assetId || r.assetType, 'assetId or assetType is required');

@Controller()
export class DevicesController {
  constructor(@Inject(POSTGIS) private readonly db: Pool) {}

  /* ------------------------------- devices -------------------------------- */

  @Get('devices')
  async listDevices(@CurrentUser() u: Principal, @Query('assetId') assetId?: string) {
    const { rows } = await this.db.query(
      `SELECT device_id AS id, asset_id AS "assetId", asset_type AS "assetType", asset_name AS "assetName",
              lon, lat, profile, protocol, schema_mapping_id AS "schemaMappingId",
              schema_mapping AS "schemaMapping", enabled
       FROM v_device_bindings WHERE tenant_id = $1 AND ($2::uuid IS NULL OR asset_id = $2::uuid)
       ORDER BY device_id`,
      [u.tenantId, assetId ?? null],
    );
    return rows;
  }

  @Put('devices')
  @RequireRole('operator')
  async upsertDevice(@CurrentUser() u: Principal, @Body(new ZodPipe(DeviceBody)) b: z.infer<typeof DeviceBody>) {
    const { rows } = await this.db.query(
      `INSERT INTO devices (tenant_id, id, asset_id, protocol, schema_mapping_id, profile, enabled, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
       ON CONFLICT (tenant_id, id) DO UPDATE SET asset_id = EXCLUDED.asset_id, protocol = EXCLUDED.protocol,
         schema_mapping_id = EXCLUDED.schema_mapping_id, profile = EXCLUDED.profile,
         enabled = EXCLUDED.enabled, metadata = EXCLUDED.metadata
       RETURNING id, asset_id AS "assetId", protocol, schema_mapping_id AS "schemaMappingId", profile, enabled, metadata`,
      [u.tenantId, b.id, b.assetId, b.protocol, b.schemaMappingId, b.profile, b.enabled, JSON.stringify(b.metadata)],
    );
    return rows[0];
  }

  @Delete('devices/:id')
  @HttpCode(204)
  @RequireRole('admin')
  async deleteDevice(@CurrentUser() u: Principal, @Param('id') id: string) {
    const res = await this.db.query('DELETE FROM devices WHERE tenant_id = $1 AND id = $2', [u.tenantId, id]);
    if (!res.rowCount) throw new NotFoundException(`device ${id} not found`);
  }

  /* ------------------------ dynamic schema mappings ------------------------ */

  @Get('schema-mappings')
  async listMappings(@CurrentUser() u: Principal) {
    const { rows } = await this.db.query(
      `SELECT id, name, protocol, mapping, version, updated_at AS "updatedAt",
              (SELECT count(*)::int FROM devices d WHERE d.schema_mapping_id = m.id) AS "deviceCount"
       FROM device_schema_mappings m WHERE tenant_id = $1 ORDER BY name`,
      [u.tenantId],
    );
    return rows;
  }

  /** Create or bump version; bridges pick up changes on their next cache refresh. */
  @Put('schema-mappings')
  @RequireRole('operator')
  async upsertMapping(@CurrentUser() u: Principal, @Body(new ZodPipe(MappingBody)) b: z.infer<typeof MappingBody>) {
    const { rows } = await this.db.query(
      `INSERT INTO device_schema_mappings (tenant_id, name, protocol, mapping)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (tenant_id, name) DO UPDATE SET protocol = EXCLUDED.protocol, mapping = EXCLUDED.mapping,
         version = device_schema_mappings.version + 1
       RETURNING id, name, protocol, mapping, version`,
      [u.tenantId, b.name, b.protocol, JSON.stringify(b.mapping)],
    );
    return rows[0];
  }

  /** Dry-run a mapping against a sample payload before binding devices to it. */
  @Post('schema-mappings/test')
  @HttpCode(200)
  testMapping(@Body(new ZodPipe(MappingTestBody)) b: z.infer<typeof MappingTestBody>) {
    return applySchemaMapping(b.mapping, b.payload);
  }

  /* ------------------------------ alert rules ------------------------------ */

  @Get('alert-rules')
  async listRules(@CurrentUser() u: Principal) {
    const { rows } = await this.db.query(
      `SELECT id, asset_id AS "assetId", asset_type AS "assetType", metric, warn_min AS "warnMin", warn_max AS "warnMax",
              crit_min AS "critMin", crit_max AS "critMax", enabled
       FROM alert_rules WHERE tenant_id = $1 ORDER BY asset_type NULLS LAST, metric`,
      [u.tenantId],
    );
    return rows;
  }

  @Post('alert-rules')
  @RequireRole('operator')
  async createRule(@CurrentUser() u: Principal, @Body(new ZodPipe(RuleBody)) r: z.infer<typeof RuleBody>) {
    const { rows } = await this.db.query(
      `INSERT INTO alert_rules (tenant_id, asset_id, asset_type, metric, warn_min, warn_max, crit_min, crit_max, enabled)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [u.tenantId, r.assetId, r.assetId ? null : r.assetType, r.metric, r.warnMin, r.warnMax, r.critMin, r.critMax, r.enabled],
    );
    return rows[0];
  }

  @Delete('alert-rules/:id')
  @HttpCode(204)
  @RequireRole('operator')
  async deleteRule(@CurrentUser() u: Principal, @Param('id', ParseUUIDPipe) id: string) {
    const res = await this.db.query('DELETE FROM alert_rules WHERE tenant_id = $1 AND id = $2', [u.tenantId, id]);
    if (!res.rowCount) throw new NotFoundException(`rule ${id} not found`);
  }
}

@Module({ controllers: [DevicesController] })
export class DevicesModule {}
