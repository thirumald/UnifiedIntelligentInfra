import { SchemaMapping } from '@dt/contracts';
import { describe, expect, it } from 'vitest';
import { normalize } from './normalize';

const NOW = 1_750_000_000_000;
const buf = (v: unknown) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v));

describe('normalize', () => {
  it('accepts canonical payloads from any device', () => {
    const r = normalize('default', 'rack-01', 'telemetry', buf({ ts: NOW - 1000, readings: [{ metric: 'power_kw', value: 5.2, unit: 'kW' }] }), undefined, NOW);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.envelope).toMatchObject({ tenantId: 'default', deviceId: 'rack-01', ts: NOW - 1000, receivedAt: NOW, source: 'mqtt' });
      expect(r.envelope.readings[0]).toMatchObject({ metric: 'power_kw', value: 5.2, quality: 'good' });
    }
  });

  it('maps vendor payloads through the bound schema mapping', () => {
    const mapping = SchemaMapping.parse({
      timestampPath: 'timestamp',
      timestampUnit: 's',
      fields: [{ path: 'objects.ZN-T.presentValue', metric: 'temperature_c', scale: 0.1 }],
    });
    const r = normalize('default', 'hvac-05', 'telemetry', buf({ timestamp: (NOW - 2000) / 1000, objects: { 'ZN-T': { presentValue: 241 } } }), { schemaMapping: mapping }, NOW);
    expect(r.ok && r.envelope.readings[0]?.value).toBe(24.1);
    expect(r.ok && r.envelope.ts).toBe(NOW - 2000);
  });

  it('routes unknown shapes and bad JSON to the DLQ', () => {
    expect(normalize('d', 'x', 'telemetry', buf({ foo: 1 }), undefined, NOW)).toMatchObject({ ok: false, reason: 'unknown_payload_shape' });
    expect(normalize('d', 'x', 'telemetry', buf('{not json'), undefined, NOW)).toMatchObject({ ok: false, reason: 'invalid_json' });
  });

  it('replaces implausible device clocks with receive time', () => {
    const r = normalize('d', 'x', 'telemetry', buf({ ts: NOW + 3_600_000, readings: [{ metric: 'a', value: 1 }] }), undefined, NOW);
    expect(r.ok && r.envelope.ts).toBe(NOW);
  });

  it('turns status messages into an online reading', () => {
    const r = normalize('d', 'cam-01', 'status', buf('offline'), undefined, NOW);
    expect(r.ok && r.envelope.readings).toEqual([{ metric: 'online', value: false, quality: 'good' }]);
  });
});
