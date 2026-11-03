import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { AssetFeature, AssetFeatureCollection, AssetInput, AssetPatch, AssetEvent } from '@dt/contracts';
import { withTransaction, type Pool, type PoolClient } from '@dt/db';
import { randomUUID } from 'node:crypto';
import { API_ENV, type ApiEnv } from '../config';
import { EventBus, POSTGIS } from '../infra/infra.module';

/** Projection shared by every read path → one Feature mapper. */
const SELECT_ASSET = `
  SELECT a.id, a.tenant_id, a.external_id, a.name, a.type, a.domain, a.status, a.parent_id,
         ST_X(a.location) AS lon, ST_Y(a.location) AS lat, a.altitude_m,
         a.bim_model_id, a.ifc_guid, a.ifc_class, a.local_x, a.local_y, a.local_z, a.storey,
         a.attributes, a.tags, a.created_at, a.updated_at,
         COALESCE((SELECT array_agg(d.id ORDER BY d.id) FROM devices d
                   WHERE d.asset_id = a.id AND d.tenant_id = a.tenant_id), '{}') AS device_ids
  FROM assets a`;

interface AssetRow {
  id: string;
  tenant_id: string;
  external_id: string | null;
  name: string;
  type: AssetInput['type'];
  domain: AssetInput['domain'];
  status: AssetInput['status'];
  parent_id: string | null;
  lon: number;
  lat: number;
  altitude_m: number | null;
  bim_model_id: string | null;
  ifc_guid: string | null;
  ifc_class: string | null;
  local_x: number | null;
  local_y: number | null;
  local_z: number | null;
  storey: string | null;
  attributes: Record<string, unknown>;
  tags: string[];
  created_at: Date;
  updated_at: Date;
  device_ids: string[];
  distance_m?: number;
}

export function toFeature(r: AssetRow): AssetFeature {
  const coordinates: [number, number] | [number, number, number] =
    r.altitude_m === null || r.altitude_m === undefined ? [r.lon, r.lat] : [r.lon, r.lat, r.altitude_m];
  return {
    type: 'Feature',
    id: r.id,
    geometry: { type: 'Point', coordinates },
    properties: {
      id: r.id,
      tenantId: r.tenant_id,
      externalId: r.external_id ?? undefined,
      name: r.name,
      type: r.type,
      domain: r.domain,
      status: r.status,
      parentId: r.parent_id,
      bim:
        r.bim_model_id && r.ifc_guid
          ? {
              modelId: r.bim_model_id,
              ifcGuid: r.ifc_guid.trim(),
              ifcClass: r.ifc_class ?? undefined,
              local: { x: r.local_x ?? 0, y: r.local_y ?? 0, z: r.local_z ?? 0 },
              storey: r.storey ?? undefined,
            }
          : null,
      deviceIds: r.device_ids,
      attributes: { ...r.attributes, ...(r.distance_m !== undefined ? { distance_m: Math.round(r.distance_m * 10) / 10 } : {}) },
      tags: r.tags,
      createdAt: r.created_at.toISOString(),
      updatedAt: r.updated_at.toISOString(),
    },
  };
}

export interface AssetQuery {
  bbox?: [number, number, number, number];
  types?: string[];
  domain?: string;
  q?: string;
  modelId?: string;
  tag?: string;
  parentId?: string;
  limit: number;
  cursor?: string;
}

@Injectable()
export class AssetsService {
  constructor(
    @Inject(POSTGIS) private readonly db: Pool,
    @Inject(API_ENV) private readonly env: ApiEnv,
    private readonly bus: EventBus,
  ) {}

  async list(tenantId: string, q: AssetQuery): Promise<AssetFeatureCollection> {
    const where: string[] = ['a.tenant_id = $1'];
    const vals: unknown[] = [tenantId];
    const p = (v: unknown) => {
      vals.push(v);
      return `$${vals.length}`;
    };

    if (q.bbox) where.push(`a.location && ST_MakeEnvelope(${p(q.bbox[0])}, ${p(q.bbox[1])}, ${p(q.bbox[2])}, ${p(q.bbox[3])}, 4326)`);
    if (q.types?.length) where.push(`a.type = ANY(${p(q.types)}::text[])`);
    if (q.domain) where.push(`a.domain = ${p(q.domain)}`);
    if (q.modelId) where.push(`a.bim_model_id = ${p(q.modelId)}::uuid`);
    if (q.tag) where.push(`${p(q.tag)} = ANY(a.tags)`);
    if (q.parentId) where.push(`a.parent_id = ${p(q.parentId)}::uuid`);
    if (q.q) {
      const term = p(q.q);
      where.push(`(a.name ILIKE '%' || ${term} || '%' OR a.external_id ILIKE '%' || ${term} || '%' OR a.name % ${term})`);
    }
    if (q.cursor) where.push(`a.id > ${p(q.cursor)}::uuid`);

    const limitParam = p(q.limit + 1);
    const { rows } = await this.db.query<AssetRow>(
      `${SELECT_ASSET} WHERE ${where.join(' AND ')} ORDER BY a.id LIMIT ${limitParam}`,
      vals,
    );
    const page = rows.slice(0, q.limit);
    return {
      type: 'FeatureCollection',
      features: page.map(toFeature),
      nextCursor: rows.length > q.limit ? (page[page.length - 1]?.id ?? null) : null,
    };
  }

  async nearby(tenantId: string, lon: number, lat: number, radiusM: number, limit: number): Promise<AssetFeatureCollection> {
    const { rows } = await this.db.query<AssetRow>(
      `SELECT * FROM (
         ${SELECT_ASSET.replace(
           'FROM assets a',
           ", ST_Distance(a.location::geography, ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography) AS distance_m FROM assets a",
         )}
         WHERE a.tenant_id = $1
           AND ST_DWithin(a.location::geography, ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography, $4)
       ) s ORDER BY s.distance_m LIMIT $5`,
      [tenantId, lon, lat, radiusM, limit],
    );
    return { type: 'FeatureCollection', features: rows.map(toFeature), nextCursor: null };
  }

  async get(tenantId: string, id: string, client: Pool | PoolClient = this.db): Promise<AssetFeature> {
    const { rows } = await client.query<AssetRow>(`${SELECT_ASSET} WHERE a.tenant_id = $1 AND a.id = $2`, [tenantId, id]);
    if (!rows[0]) throw new NotFoundException(`asset ${id} not found`);
    return toFeature(rows[0]);
  }

  private async bindDevices(client: PoolClient, tenantId: string, assetId: string, deviceIds: string[]): Promise<void> {
    await client.query(
      `UPDATE devices SET asset_id = NULL WHERE tenant_id = $1 AND asset_id = $2 AND NOT (id = ANY($3::text[]))`,
      [tenantId, assetId, deviceIds],
    );
    if (deviceIds.length === 0) return;
    await client.query(
      `INSERT INTO devices (tenant_id, id, asset_id)
       SELECT $1, d, $2 FROM unnest($3::text[]) AS d
       ON CONFLICT (tenant_id, id) DO UPDATE SET asset_id = EXCLUDED.asset_id`,
      [tenantId, assetId, deviceIds],
    );
  }

  private emit(tenantId: string, assetId: string, action: AssetEvent['action'], actor: string, changes?: Record<string, unknown>) {
    const event: AssetEvent = { schemaVersion: 1, eventId: randomUUID(), tenantId, assetId, action, ts: Date.now(), actor, changes };
    this.bus.publishSafe(this.env.TOPIC_ASSET_EVENTS, [{ key: assetId, value: event }]);
  }

  /** Insert or (when externalId matches) update — used by create and bulk import. */
  private async upsert(client: PoolClient, tenantId: string, input: AssetInput): Promise<{ id: string; inserted: boolean }> {
    const [lon, lat, alt] = input.location.coordinates;
    const bim = input.bim ?? null;
    const { rows } = await client.query<{ id: string; inserted: boolean }>(
      `INSERT INTO assets (tenant_id, external_id, name, type, domain, status, parent_id, location, altitude_m,
                           bim_model_id, ifc_guid, ifc_class, local_x, local_y, local_z, storey, attributes, tags)
       VALUES ($1, $2, $3, $4, $5, $6, $7, ST_SetSRID(ST_MakePoint($8, $9), 4326), $10,
               $11, $12, $13, $14, $15, $16, $17, $18::jsonb, $19::text[])
       ON CONFLICT (tenant_id, external_id) WHERE external_id IS NOT NULL DO UPDATE SET
         name = EXCLUDED.name, type = EXCLUDED.type, domain = EXCLUDED.domain, status = EXCLUDED.status,
         parent_id = EXCLUDED.parent_id, location = EXCLUDED.location, altitude_m = EXCLUDED.altitude_m,
         bim_model_id = EXCLUDED.bim_model_id, ifc_guid = EXCLUDED.ifc_guid, ifc_class = EXCLUDED.ifc_class,
         local_x = EXCLUDED.local_x, local_y = EXCLUDED.local_y, local_z = EXCLUDED.local_z, storey = EXCLUDED.storey,
         attributes = assets.attributes || EXCLUDED.attributes, tags = EXCLUDED.tags
       RETURNING id, (xmax = 0) AS inserted`,
      [
        tenantId,
        input.externalId ?? null,
        input.name,
        input.type,
        input.domain,
        input.status,
        input.parentId ?? null,
        lon,
        lat,
        alt ?? null,
        bim?.modelId ?? null,
        bim?.ifcGuid ?? null,
        bim?.ifcClass ?? null,
        bim?.local.x ?? null,
        bim?.local.y ?? null,
        bim?.local.z ?? null,
        bim?.storey ?? null,
        JSON.stringify(input.attributes),
        input.tags,
      ],
    );
    const row = rows[0]!;
    await this.bindDevices(client, tenantId, row.id, input.deviceIds);
    return row;
  }

  async create(tenantId: string, input: AssetInput, actor: string): Promise<AssetFeature> {
    const feature = await withTransaction(this.db, async (client) => {
      const { id } = await this.upsert(client, tenantId, input);
      return this.get(tenantId, id, client);
    });
    this.emit(tenantId, feature.id, 'created', actor);
    return feature;
  }

  async importCollection(
    tenantId: string,
    inputs: AssetInput[],
    actor: string,
  ): Promise<{ inserted: number; updated: number; ids: string[] }> {
    const result = await withTransaction(this.db, async (client) => {
      let inserted = 0;
      const ids: string[] = [];
      for (const input of inputs) {
        const r = await this.upsert(client, tenantId, input);
        ids.push(r.id);
        if (r.inserted) inserted++;
      }
      return { inserted, updated: inputs.length - inserted, ids };
    });
    for (const id of result.ids) this.emit(tenantId, id, 'created', actor);
    return result;
  }

  async update(tenantId: string, id: string, patch: AssetPatch, actor: string): Promise<AssetFeature> {
    const sets: string[] = [];
    const vals: unknown[] = [tenantId, id];
    const p = (v: unknown) => {
      vals.push(v);
      return `$${vals.length}`;
    };
    const simple: [keyof AssetPatch, string][] = [
      ['externalId', 'external_id'],
      ['name', 'name'],
      ['type', 'type'],
      ['domain', 'domain'],
      ['status', 'status'],
      ['parentId', 'parent_id'],
    ];
    for (const [key, col] of simple) if (patch[key] !== undefined) sets.push(`${col} = ${p(patch[key])}`);
    if (patch.location) {
      const [lon, lat, alt] = patch.location.coordinates;
      sets.push(`location = ST_SetSRID(ST_MakePoint(${p(lon)}, ${p(lat)}), 4326)`, `altitude_m = ${p(alt ?? null)}`);
    }
    if (patch.bim !== undefined) {
      const b = patch.bim;
      sets.push(
        `bim_model_id = ${p(b?.modelId ?? null)}`,
        `ifc_guid = ${p(b?.ifcGuid ?? null)}`,
        `ifc_class = ${p(b?.ifcClass ?? null)}`,
        `local_x = ${p(b?.local.x ?? null)}`,
        `local_y = ${p(b?.local.y ?? null)}`,
        `local_z = ${p(b?.local.z ?? null)}`,
        `storey = ${p(b?.storey ?? null)}`,
      );
    }
    // Attributes merge (JSON merge-patch semantics at the top level)
    if (patch.attributes) sets.push(`attributes = attributes || ${p(JSON.stringify(patch.attributes))}::jsonb`);
    if (patch.tags) sets.push(`tags = ${p(patch.tags)}::text[]`);

    const feature = await withTransaction(this.db, async (client) => {
      if (sets.length) {
        const res = await client.query(`UPDATE assets SET ${sets.join(', ')} WHERE tenant_id = $1 AND id = $2`, vals);
        if (res.rowCount === 0) throw new NotFoundException(`asset ${id} not found`);
      }
      if (patch.deviceIds) await this.bindDevices(client, tenantId, id, patch.deviceIds);
      return this.get(tenantId, id, client);
    });
    this.emit(tenantId, id, 'updated', actor, patch as Record<string, unknown>);
    return feature;
  }

  async remove(tenantId: string, id: string, actor: string): Promise<void> {
    const res = await this.db.query('DELETE FROM assets WHERE tenant_id = $1 AND id = $2', [tenantId, id]);
    if (res.rowCount === 0) throw new NotFoundException(`asset ${id} not found`);
    this.emit(tenantId, id, 'deleted', actor);
  }

  /** Device ids bound to assets — used by telemetry endpoints and the WS gateway. */
  async deviceIdsForAssets(tenantId: string, assetIds: string[]): Promise<string[]> {
    const { rows } = await this.db.query<{ id: string }>(
      'SELECT id FROM devices WHERE tenant_id = $1 AND asset_id = ANY($2::uuid[])',
      [tenantId, assetIds],
    );
    return rows.map((r) => r.id);
  }

  async deviceIdsInBbox(tenantId: string, bbox: [number, number, number, number]): Promise<string[]> {
    const { rows } = await this.db.query<{ id: string }>(
      `SELECT d.id FROM devices d JOIN assets a ON a.id = d.asset_id
       WHERE d.tenant_id = $1 AND a.location && ST_MakeEnvelope($2, $3, $4, $5, 4326)`,
      [tenantId, ...bbox],
    );
    return rows.map((r) => r.id);
  }

  /** Aggregate counts for the console header */
  async summary(tenantId: string) {
    const { rows } = await this.db.query<{ type: string; domain: string; count: number }>(
      'SELECT type, domain, count(*)::int AS count FROM assets WHERE tenant_id = $1 GROUP BY 1, 2 ORDER BY 1',
      [tenantId],
    );
    const { rows: ext } = await this.db.query<{ extent: string | null }>(
      'SELECT ST_AsGeoJSON(ST_Extent(location)::geometry) AS extent FROM assets WHERE tenant_id = $1',
      [tenantId],
    );
    return { byType: rows, total: rows.reduce((s, r) => s + r.count, 0), extent: ext[0]?.extent ? JSON.parse(ext[0].extent) : null };
  }
}
