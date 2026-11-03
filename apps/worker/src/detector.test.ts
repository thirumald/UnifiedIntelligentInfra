import { describe, expect, it } from 'vitest';
import { AnomalyDetector, classify, type DeviceContext, type ThresholdRule } from './detector';

const ctx: DeviceContext = { tenantId: 't', deviceId: 'hvac-01', assetId: null, assetType: 'hvac_unit' };
const rule: ThresholdRule = { metric: 'temperature_c', warnMin: 16, warnMax: 27, critMin: 12, critMax: 30 };

describe('classify', () => {
  it('prefers critical over warning bands', () => {
    expect(classify(31, rule)).toEqual({ severity: 'critical', bound: 30, side: 'high' });
    expect(classify(28, rule)).toEqual({ severity: 'warning', bound: 27, side: 'high' });
    expect(classify(14, rule)).toEqual({ severity: 'warning', bound: 16, side: 'low' });
    expect(classify(22, rule)).toBeNull();
  });
});

describe('AnomalyDetector', () => {
  const make = () =>
    new AnomalyDetector({ zScoreThreshold: 3.5, windowSize: 60, minSamples: 20 }, (_c, m) => (m === 'temperature_c' ? rule : null));

  it('opens once, escalates, then resolves on return to normal', () => {
    const d = make();
    expect(d.evaluate(ctx, 'temperature_c', 22, 1).opened).toHaveLength(0);

    const w = d.evaluate(ctx, 'temperature_c', 28, 2);
    expect(w.opened).toHaveLength(1);
    expect(w.opened[0]).toMatchObject({ severity: 'warning', detector: 'threshold', threshold: 27 });
    // still warning → no duplicate event
    expect(d.evaluate(ctx, 'temperature_c', 28.5, 3).opened).toHaveLength(0);
    expect(d.deviceStatus('t', 'hvac-01').status).toBe('warning');

    const c = d.evaluate(ctx, 'temperature_c', 31, 4);
    expect(c.opened[0]?.severity).toBe('critical');
    expect(c.resolvedIds).toEqual([w.opened[0]!.anomalyId]);
    expect(d.deviceStatus('t', 'hvac-01').status).toBe('critical');

    const n = d.evaluate(ctx, 'temperature_c', 23, 5);
    expect(n.resolvedIds).toEqual([c.opened[0]!.anomalyId]);
    expect(d.deviceStatus('t', 'hvac-01')).toEqual({ status: 'normal', active: [] });
  });

  it('flags statistical outliers on metrics without thresholds', () => {
    const d = make();
    for (let i = 0; i < 40; i++) d.evaluate(ctx, 'fan_speed_pct', 50 + (i % 2 ? 1 : -1), i);
    const spike = d.evaluate(ctx, 'fan_speed_pct', 95, 41);
    expect(spike.opened).toHaveLength(1);
    expect(spike.opened[0]).toMatchObject({ detector: 'zscore', severity: 'warning' });
    // the outlier must not shift the baseline: a normal value resolves it
    expect(d.evaluate(ctx, 'fan_speed_pct', 50, 42).resolvedIds).toHaveLength(1);
  });

  it('does not z-score before the warm-up window fills', () => {
    const d = make();
    for (let i = 0; i < 5; i++) d.evaluate(ctx, 'fan_speed_pct', 50, i);
    expect(d.evaluate(ctx, 'fan_speed_pct', 500, 6).opened).toHaveLength(0);
  });

  it('applies hysteresis so values hovering on a limit do not flap', () => {
    const d = make();
    expect(d.evaluate(ctx, 'temperature_c', 27.2, 1).opened).toHaveLength(1); // > warnMax 27
    for (const v of [26.9, 27.1, 26.7, 27.05]) {
      const r = d.evaluate(ctx, 'temperature_c', v, 2);
      expect(r.opened).toHaveLength(0);
      expect(r.resolvedIds).toHaveLength(0);
    }
    expect(d.evaluate(ctx, 'temperature_c', 26.3, 3).resolvedIds).toHaveLength(1); // below 27 − 0.54
  });

  it('resetDevice closes every open anomaly for the device', () => {
    const d = make();
    const a = d.evaluate(ctx, 'temperature_c', 35, 1).opened[0]!;
    expect(d.resetDevice('t', 'hvac-01')).toEqual([a.anomalyId]);
    expect(d.deviceStatus('t', 'hvac-01').status).toBe('normal');
  });
});
