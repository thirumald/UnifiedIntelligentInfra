import { z } from 'zod';

/**
 * Spatial asset contract — mirrors the PostGIS `assets` table (Phase 2).
 * Location is WGS84 (EPSG:4326) GeoJSON; BIM placement is expressed both as
 * the IFC GlobalId and as a local offset (metres, ENU) from the model origin
 * so the same asset renders on the GIS map and inside the BIM viewport.
 */

export const AssetDomain = z.enum(['it', 'ot', 'facility', 'safety', 'mobility']);
export type AssetDomain = z.infer<typeof AssetDomain>;

export const AssetType = z.enum([
  'hvac_unit',
  'server_rack',
  'network_switch',
  'pdu',
  'ups',
  'cctv_camera',
  'plc',
  'scada_rtu',
  'sensor',
  'access_controller',
  'streetlight',
  'traffic_signal',
  'building',
  'floor',
  'room',
  'other',
]);
export type AssetType = z.infer<typeof AssetType>;

export const AssetStatus = z.enum(['active', 'maintenance', 'decommissioned', 'planned']);
export type AssetStatus = z.infer<typeof AssetStatus>;

/** IFC GlobalId — 22-char base64 variant used by buildingSMART */
export const IfcGuid = z.string().regex(/^[0-9A-Za-z_$]{22}$/, 'invalid IFC GlobalId');

export const GeoJsonPoint = z.object({
  type: z.literal('Point'),
  /** [lon, lat] or [lon, lat, altitude_m] */
  coordinates: z.union([
    z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]),
    z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90), z.number()]),
  ]),
});
export type GeoJsonPoint = z.infer<typeof GeoJsonPoint>;

export const BimPlacement = z.object({
  modelId: z.string().uuid(),
  ifcGuid: IfcGuid,
  ifcClass: z.string().regex(/^Ifc[A-Za-z]+$/).optional(),
  /** Local ENU offset from model origin, metres */
  local: z.object({ x: z.number(), y: z.number(), z: z.number() }),
  storey: z.string().max(64).optional(),
});
export type BimPlacement = z.infer<typeof BimPlacement>;

export const AssetInput = z.object({
  externalId: z.string().max(128).optional(),
  name: z.string().min(1).max(200),
  type: AssetType,
  domain: AssetDomain,
  status: AssetStatus.default('active'),
  parentId: z.string().uuid().nullable().optional(),
  location: GeoJsonPoint,
  bim: BimPlacement.nullable().optional(),
  /** Bound telemetry source(s) */
  deviceIds: z.array(z.string().min(1).max(128)).default([]),
  /** Schema-less vendor / CMDB attributes (JSONB) */
  attributes: z.record(z.unknown()).default({}),
  tags: z.array(z.string().max(64)).default([]),
});
export type AssetInput = z.infer<typeof AssetInput>;

export const AssetPatch = AssetInput.partial();
export type AssetPatch = z.infer<typeof AssetPatch>;

/** GeoJSON Feature returned by the API */
export interface AssetFeature {
  type: 'Feature';
  id: string;
  geometry: GeoJsonPoint;
  properties: Omit<AssetInput, 'location'> & {
    id: string;
    tenantId: string;
    createdAt: string;
    updatedAt: string;
  };
}

export interface AssetFeatureCollection {
  type: 'FeatureCollection';
  features: AssetFeature[];
  /** Pagination cursor for large result sets */
  nextCursor: string | null;
}

/** Asset lifecycle event on dt.asset.events */
export const AssetEvent = z.object({
  schemaVersion: z.literal(1),
  eventId: z.string().uuid(),
  tenantId: z.string(),
  assetId: z.string().uuid(),
  action: z.enum(['created', 'updated', 'deleted', 'device_bound', 'device_unbound']),
  ts: z.number().int(),
  actor: z.string(),
  changes: z.record(z.unknown()).optional(),
});
export type AssetEvent = z.infer<typeof AssetEvent>;
