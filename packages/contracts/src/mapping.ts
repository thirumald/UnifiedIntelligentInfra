import { z } from 'zod';
import type { Reading } from './telemetry.js';

/**
 * Dynamic schema mapping — turns arbitrary vendor / legacy OT payloads
 * (BACnet object dumps, Modbus register maps, proprietary JSON) into
 * canonical readings. Mappings are data in PostGIS, editable at runtime
 * through the API, so onboarding a new device family needs no deployment.
 */

export const FieldMapping = z.object({
  /** Dot path into the payload, e.g. "objects.ZN-T.presentValue" or "$.registers.40001" */
  path: z.string().min(1),
  metric: z.string().regex(/^[a-z][a-z0-9_]*$/),
  unit: z.string().max(16).optional(),
  /** value = raw * scale + offset (numeric fields only) */
  scale: z.number().default(1),
  offset: z.number().default(0),
  type: z.enum(['number', 'boolean', 'string']).default('number'),
});
export type FieldMapping = z.infer<typeof FieldMapping>;

export const SchemaMapping = z.object({
  timestampPath: z.string().optional(),
  timestampUnit: z.enum(['ms', 's', 'iso']).default('ms'),
  fields: z.array(FieldMapping).min(1).max(500),
});
export type SchemaMapping = z.infer<typeof SchemaMapping>;

function readPath(obj: unknown, path: string): unknown {
  const clean = path.startsWith('$.') ? path.slice(2) : path;
  let cur: unknown = obj;
  for (const key of clean.split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function toBool(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (['true', '1', 'on', 'active', 'yes'].includes(s)) return true;
    if (['false', '0', 'off', 'inactive', 'no'].includes(s)) return false;
  }
  return undefined;
}

export interface MappingResult {
  ts: number | null;
  readings: Reading[];
  /** Paths that were missing or not coercible — surfaced for diagnostics */
  unmapped: string[];
}

/** Apply a mapping to a payload. Pure and deterministic — unit tested. */
export function applySchemaMapping(mapping: SchemaMapping, payload: unknown): MappingResult {
  const readings: Reading[] = [];
  const unmapped: string[] = [];

  for (const f of mapping.fields) {
    const raw = readPath(payload, f.path);
    if (raw === undefined || raw === null) {
      unmapped.push(f.path);
      continue;
    }
    if (f.type === 'boolean') {
      const b = toBool(raw);
      if (b === undefined) unmapped.push(f.path);
      else readings.push({ metric: f.metric, value: b, unit: f.unit, quality: 'good' });
    } else if (f.type === 'string') {
      readings.push({ metric: f.metric, value: String(raw).slice(0, 256), unit: f.unit, quality: 'good' });
    } else {
      const n = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isFinite(n)) unmapped.push(f.path);
      else readings.push({ metric: f.metric, value: Math.round((n * f.scale + f.offset) * 1e6) / 1e6, unit: f.unit, quality: 'good' });
    }
  }

  let ts: number | null = null;
  if (mapping.timestampPath) {
    const t = readPath(payload, mapping.timestampPath);
    if (mapping.timestampUnit === 'iso' && typeof t === 'string') {
      const parsed = Date.parse(t);
      ts = Number.isNaN(parsed) ? null : parsed;
    } else if (typeof t === 'number' || (typeof t === 'string' && t.trim() !== '')) {
      const n = Number(t);
      if (Number.isFinite(n)) ts = mapping.timestampUnit === 's' ? Math.round(n * 1000) : Math.round(n);
    }
  }
  return { ts, readings, unmapped };
}
