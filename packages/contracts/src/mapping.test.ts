import { describe, expect, it } from 'vitest';
import { applySchemaMapping, SchemaMapping } from './mapping.js';
import { mqttTopic, parseMqttTopic, topic } from './topics.js';

describe('applySchemaMapping', () => {
  const bacnet = SchemaMapping.parse({
    timestampPath: 'timestamp',
    timestampUnit: 's',
    fields: [
      { path: 'objects.ZN-T.presentValue', metric: 'temperature_c', unit: 'C', scale: 0.1 },
      { path: 'objects.ALM.presentValue', metric: 'alarm', type: 'boolean' },
      { path: 'objects.MISSING.presentValue', metric: 'missing_metric' },
    ],
  });

  it('scales numeric registers and coerces booleans', () => {
    const r = applySchemaMapping(bacnet, {
      timestamp: 1_700_000_000,
      objects: { 'ZN-T': { presentValue: 235 }, ALM: { presentValue: 'active' } },
    });
    expect(r.ts).toBe(1_700_000_000_000);
    expect(r.readings).toEqual([
      { metric: 'temperature_c', value: 23.5, unit: 'C', quality: 'good' },
      { metric: 'alarm', value: true, unit: undefined, quality: 'good' },
    ]);
    expect(r.unmapped).toEqual(['objects.MISSING.presentValue']);
  });

  it('rejects non-numeric values for numeric fields', () => {
    const r = applySchemaMapping(bacnet, { objects: { 'ZN-T': { presentValue: 'n/a' } } });
    expect(r.readings).toHaveLength(0);
    expect(r.ts).toBeNull();
  });

  it('supports $. prefixed paths and offsets', () => {
    const m = SchemaMapping.parse({ fields: [{ path: '$.registers.40001', metric: 'pressure_bar', scale: 0.01, offset: -1 }] });
    expect(applySchemaMapping(m, { registers: { '40001': 450 } }).readings[0]?.value).toBe(3.5);
  });
});

describe('MQTT topic contract', () => {
  it('round-trips', () => {
    const t = mqttTopic('default', 'hvac-01', 'telemetry');
    expect(t).toBe('dt/v1/default/hvac-01/telemetry');
    expect(parseMqttTopic(t)).toEqual({ tenantId: 'default', deviceId: 'hvac-01', channel: 'telemetry' });
  });
  it('rejects foreign topics', () => {
    expect(parseMqttTopic('other/v1/a/b/telemetry')).toBeNull();
    expect(parseMqttTopic('dt/v1/a/b/c/telemetry')).toBeNull();
    expect(parseMqttTopic('dt/v1/a/b/unknown')).toBeNull();
  });
  it('honours env topic overrides', () => {
    expect(topic('TelemetryRaw', { TOPIC_TELEMETRY_RAW: 'custom.raw' })).toBe('custom.raw');
    expect(topic('TelemetryDlq', {})).toBe('dt.telemetry.dlq');
  });
});
