import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Module,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Pool } from '@dt/db';
import type { Response } from 'express';
import { createReadStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { diskStorage } from 'multer';
import { z } from 'zod';
import { CurrentUser, RequireRole, type Principal } from '../auth/auth';
import { ZodPipe } from '../common/zod.pipe';
import { API_ENV, apiEnv, type ApiEnv } from '../config';
import { EventBus, POSTGIS, log } from '../infra/infra.module';

const BIM_SELECT = `
  SELECT id, name, ST_X(origin) AS lon, ST_Y(origin) AS lat, origin_alt_m AS "originAltM",
         rotation_deg AS "rotationDeg", width_m AS "widthM", depth_m AS "depthM", storeys,
         ifc_schema AS "ifcSchema", file_size AS "fileSize", status, element_count AS "elementCount",
         error, created_at AS "createdAt", updated_at AS "updatedAt",
         (SELECT count(*)::int FROM assets a WHERE a.bim_model_id = m.id) AS "assetCount"
  FROM bim_models m`;

const UploadFields = z.object({
  name: z.string().min(1).max(200),
  lon: z.coerce.number().min(-180).max(180),
  lat: z.coerce.number().min(-90).max(90),
  altitude: z.coerce.number().default(0),
  rotationDeg: z.coerce.number().min(-360).max(360).default(0),
});

const SchematicBody = UploadFields.extend({
  widthM: z.number().positive().max(2000),
  depthM: z.number().positive().max(2000),
  storeys: z
    .array(z.object({ name: z.string().max(64), elevation_m: z.number(), height_m: z.number().positive() }))
    .min(1)
    .max(200),
});

const uploadLimitBytes = () => apiEnv().IFC_MAX_UPLOAD_MB * 1024 * 1024;

@Controller('bim-models')
export class BimController {
  constructor(
    @Inject(POSTGIS) private readonly db: Pool,
    @Inject(API_ENV) private readonly env: ApiEnv,
    private readonly bus: EventBus,
  ) {}

  @Get()
  async list(@CurrentUser() u: Principal) {
    const { rows } = await this.db.query(`${BIM_SELECT} WHERE tenant_id = $1 ORDER BY name`, [u.tenantId]);
    return rows;
  }

  @Get(':id')
  async get(@CurrentUser() u: Principal, @Param('id', ParseUUIDPipe) id: string) {
    const { rows } = await this.db.query(`${BIM_SELECT} WHERE tenant_id = $1 AND id = $2`, [u.tenantId, id]);
    if (!rows[0]) throw new NotFoundException(`model ${id} not found`);
    return rows[0];
  }

  /** IFC elements extracted by the background parser (GUID ↔ expressID ↔ class) */
  @Get(':id/elements')
  async elements(@CurrentUser() u: Principal, @Param('id', ParseUUIDPipe) id: string) {
    const { rows } = await this.db.query(
      `SELECT e.ifc_guid AS "ifcGuid", e.express_id AS "expressId", e.ifc_class AS "ifcClass", e.name, e.storey
       FROM bim_elements e JOIN bim_models m ON m.id = e.model_id
       WHERE m.tenant_id = $1 AND e.model_id = $2 ORDER BY e.ifc_class, e.name`,
      [u.tenantId, id],
    );
    return rows;
  }

  /** Raw IFC for the browser viewer (web-ifc parses client-side) */
  @Get(':id/file')
  async file(@CurrentUser() u: Principal, @Param('id', ParseUUIDPipe) id: string, @Res({ passthrough: true }) res: Response) {
    const { rows } = await this.db.query<{ file_path: string | null; name: string }>(
      'SELECT file_path, name FROM bim_models WHERE tenant_id = $1 AND id = $2',
      [u.tenantId, id],
    );
    const path = rows[0]?.file_path;
    if (!path) throw new NotFoundException('model has no IFC file');
    const info = await stat(path).catch(() => null);
    if (!info) throw new NotFoundException('IFC file missing from storage');
    res.set({ 'Content-Type': 'application/x-step', 'Content-Length': String(info.size), 'Cache-Control': 'private, max-age=3600' });
    return new StreamableFile(createReadStream(path));
  }

  /** Schematic envelope — lets teams place assets before an IFC model exists */
  @Post('schematic')
  @RequireRole('operator')
  async createSchematic(@CurrentUser() u: Principal, @Body(new ZodPipe(SchematicBody)) b: z.infer<typeof SchematicBody>) {
    const { rows } = await this.db.query<{ id: string }>(
      `INSERT INTO bim_models (tenant_id, name, origin, origin_alt_m, rotation_deg, width_m, depth_m, storeys, status)
       VALUES ($1, $2, ST_SetSRID(ST_MakePoint($3, $4), 4326), $5, $6, $7, $8, $9::jsonb, 'schematic') RETURNING id`,
      [u.tenantId, b.name, b.lon, b.lat, b.altitude, b.rotationDeg, b.widthM, b.depthM, JSON.stringify(b.storeys)],
    );
    return this.get(u, rows[0]!.id);
  }

  /** Multipart IFC upload → stored on the shared volume → parse job on Kafka */
  @Post()
  @RequireRole('operator')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: (_req, _file, cb) => {
          const dir = join(apiEnv().IFC_STORAGE_DIR, 'incoming');
          mkdir(dir, { recursive: true }).then(() => cb(null, dir), (err: Error) => cb(err, dir));
        },
        filename: (_req, _file, cb) => cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}.ifc`),
      }),
      limits: { fileSize: uploadLimitBytes(), files: 1 },
      fileFilter: (_req, file, cb) => cb(null, /\.ifc$/i.test(file.originalname)),
    }),
  )
  async upload(
    @CurrentUser() u: Principal,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() body: Record<string, unknown>,
  ) {
    if (!file) throw new BadRequestException('an .ifc file is required in field "file"');
    let fields: z.infer<typeof UploadFields>;
    try {
      fields = new ZodPipe(UploadFields).transform(body);
    } catch (err) {
      await rm(file.path, { force: true });
      throw err;
    }

    const { rows } = await this.db.query<{ id: string }>(
      `INSERT INTO bim_models (tenant_id, name, origin, origin_alt_m, rotation_deg, file_size, status)
       VALUES ($1, $2, ST_SetSRID(ST_MakePoint($3, $4), 4326), $5, $6, $7, 'uploaded') RETURNING id`,
      [u.tenantId, fields.name, fields.lon, fields.lat, fields.altitude, fields.rotationDeg, file.size],
    );
    const id = rows[0]!.id;
    const finalPath = join(this.env.IFC_STORAGE_DIR, u.tenantId, `${id}.ifc`);
    await mkdir(join(this.env.IFC_STORAGE_DIR, u.tenantId), { recursive: true });
    await rename(file.path, finalPath);
    await this.db.query('UPDATE bim_models SET file_path = $2 WHERE id = $1', [id, finalPath]);

    try {
      await this.bus.publish(this.env.TOPIC_IFC_JOBS, [
        { key: id, value: { schemaVersion: 1, modelId: id, tenantId: u.tenantId, path: finalPath, requestedBy: u.sub, ts: Date.now() } },
      ]);
      await this.db.query(`UPDATE bim_models SET status = 'processing' WHERE id = $1`, [id]);
    } catch (err) {
      log.error({ err: (err as Error).message, modelId: id }, 'failed to enqueue IFC job');
      await this.db.query(`UPDATE bim_models SET status = 'failed', error = 'parse job could not be queued' WHERE id = $1`, [id]);
    }
    return this.get(u, id);
  }
}

@Module({ controllers: [BimController] })
export class BimModule {}
