import type { AnomalyEvent, DeviceStateSnapshot, Severity } from '@dt/contracts';
import { randomUUID } from 'node:crypto';

/**
 * Streaming anomaly detection — pure, deterministic, unit tested.
 *
 * Detectors
 *  1. threshold — warn/crit min/max bands. Rule precedence:
 *       asset-specific rule → asset-type rule → platform defaults.
 *  2. zscore    — rolling-window statistical outlier (catches drift on
 *                 metrics that have no configured thresholds).
 *
 * Debouncing: an anomaly is *opened* on the transition into an abnormal
 * band and *resolved* on the transition back, so a sensor sitting at
 * 31 °C produces one event, not one per reading. Severity escalation
 * (warning → critical) closes the old anomaly and opens a new one.
 */

export interface ThresholdRule {
  metric: string;
  warnMin: number | null;
  warnMax: number | null;
  critMin: number | null;
  critMax: number | null;
}

export interface DeviceContext {
  tenantId: string;
  deviceId: string;
  assetId: string | null;
  assetType: string | null;
}

export interface DetectorOptions {
  zScoreThreshold: number;
  windowSize: number;
  /** Minimum samples before z-score is trusted */
  minSamples?: number;
}

export interface Evaluation {
  opened: AnomalyEvent[];
  resolvedIds: string[];
}

interface OpenAnomaly {
  id: string;
  severity: Severity;
}

/** Fixed-size ring buffer with O(1) running mean / variance. */
class RollingStats {
  private readonly buf: number[];
  private idx = 0;
  private n = 0;
  private sum = 0;
  private sumSq = 0;

  constructor(private readonly size: number) {
    this.buf = new Array<number>(size).fill(0);
  }

  push(v: number): void {
    if (this.n === this.size) {
      const old = this.buf[this.idx]!;
      this.sum -= old;
      this.sumSq -= old * old;
    } else {
      this.n++;
    }
    this.buf[this.idx] = v;
    this.sum += v;
    this.sumSq += v * v;
    this.idx = (this.idx + 1) % this.size;
  }

  get count(): number {
    return this.n;
  }

  get mean(): number {
    return this.n ? this.sum / this.n : 0;
  }

  get std(): number {
    if (this.n < 2) return 0;
    const variance = Math.max(0, (this.sumSq - (this.sum * this.sum) / this.n) / (this.n - 1));
    return Math.sqrt(variance);
  }
}

export function classify(value: number, rule: ThresholdRule): { severity: Severity; bound: number; side: 'low' | 'high' } | null {
  if (rule.critMax !== null && value > rule.critMax) return { severity: 'critical', bound: rule.critMax, side: 'high' };
  if (rule.critMin !== null && value < rule.critMin) return { severity: 'critical', bound: rule.critMin, side: 'low' };
  if (rule.warnMax !== null && value > rule.warnMax) return { severity: 'warning', bound: rule.warnMax, side: 'high' };
  if (rule.warnMin !== null && value < rule.warnMin) return { severity: 'warning', bound: rule.warnMin, side: 'low' };
  return null;
}

const SEVERITY_RANK: Record<Severity, number> = { info: 0, warning: 1, critical: 2 };

/** Deadband applied before an open anomaly may clear or de-escalate (2 % of the bound, min 0.1). */
export function deadband(bound: number): number {
  return Math.max(Math.abs(bound) * 0.02, 0.1);
}

/** Rule with every bound moved inward by its deadband — used to hold an open state. */
export function relaxed(rule: ThresholdRule): ThresholdRule {
  const inMax = (b: number | null) => (b === null ? null : b - deadband(b));
  const inMin = (b: number | null) => (b === null ? null : b + deadband(b));
  return { metric: rule.metric, warnMax: inMax(rule.warnMax), critMax: inMax(rule.critMax), warnMin: inMin(rule.warnMin), critMin: inMin(rule.critMin) };
}

export class AnomalyDetector {
  private readonly stats = new Map<string, RollingStats>();
  /** key = device|metric|detector */
  private readonly open = new Map<string, OpenAnomaly>();
  private readonly minSamples: number;

  constructor(
    private readonly opts: DetectorOptions,
    private readonly resolveRule: (ctx: DeviceContext, metric: string) => ThresholdRule | null,
  ) {
    this.minSamples = opts.minSamples ?? Math.min(20, opts.windowSize);
  }

  evaluate(ctx: DeviceContext, metric: string, value: number, ts: number): Evaluation {
    const result: Evaluation = { opened: [], resolvedIds: [] };
    const base = `${ctx.tenantId}|${ctx.deviceId}|${metric}`;

    // ---- 1. Thresholds --------------------------------------------------
    const rule = this.resolveRule(ctx, metric);
    let hit = rule ? classify(value, rule) : null;
    // Hysteresis: an open anomaly only clears / de-escalates once the value is
    // back inside the band by the deadband, so readings hovering on a limit
    // do not flap open/resolved on every sample.
    const openThreshold = this.open.get(`${base}|threshold`);
    if (rule && openThreshold) {
      const held = classify(value, relaxed(rule));
      const strictRank = hit ? SEVERITY_RANK[hit.severity] : -1;
      if (held && SEVERITY_RANK[held.severity] >= SEVERITY_RANK[openThreshold.severity] && strictRank < SEVERITY_RANK[openThreshold.severity]) {
        hit = { ...held, severity: openThreshold.severity };
      }
    }
    this.transition(`${base}|threshold`, hit?.severity ?? null, result, () => ({
      detector: 'threshold',
      threshold: hit!.bound,
      message: `${metric} ${value} is ${hit!.side === 'high' ? 'above' : 'below'} ${hit!.severity} limit ${hit!.bound}`,
    }), ctx, metric, value, ts);

    // ---- 2. Rolling z-score (only when no threshold rule applies) --------
    let stats = this.stats.get(base);
    if (!stats) this.stats.set(base, (stats = new RollingStats(this.opts.windowSize)));
    let zSeverity: Severity | null = null;
    let z = 0;
    if (!rule && stats.count >= this.minSamples && stats.std > 1e-9) {
      z = (value - stats.mean) / stats.std;
      if (Math.abs(z) >= this.opts.zScoreThreshold) zSeverity = 'warning';
    }
    this.transition(`${base}|zscore`, zSeverity, result, () => ({
      detector: 'zscore',
      threshold: Math.round(z * 100) / 100,
      message: `${metric} ${value} deviates ${Math.abs(z).toFixed(1)}σ from rolling mean ${stats!.mean.toFixed(2)}`,
    }), ctx, metric, value, ts);
    // Do not let a confirmed outlier pollute the baseline
    if (zSeverity === null) stats.push(value);

    return result;
  }

  private transition(
    key: string,
    severity: Severity | null,
    result: Evaluation,
    describe: () => Pick<AnomalyEvent, 'detector' | 'threshold' | 'message'>,
    ctx: DeviceContext,
    metric: string,
    value: number,
    ts: number,
  ): void {
    const current = this.open.get(key);
    if (current && (severity === null || SEVERITY_RANK[severity] !== SEVERITY_RANK[current.severity])) {
      result.resolvedIds.push(current.id);
      this.open.delete(key);
    }
    if (severity !== null && (!current || SEVERITY_RANK[severity] !== SEVERITY_RANK[current.severity])) {
      const id = randomUUID();
      this.open.set(key, { id, severity });
      result.opened.push({
        schemaVersion: 1,
        anomalyId: id,
        tenantId: ctx.tenantId,
        deviceId: ctx.deviceId,
        assetId: ctx.assetId,
        metric,
        value,
        ts,
        severity,
        ...describe(),
      });
    }
  }

  /** Worst open severity for a device → drives marker / BIM colour */
  deviceStatus(tenantId: string, deviceId: string): { status: DeviceStateSnapshot['status']; active: string[] } {
    const prefix = `${tenantId}|${deviceId}|`;
    let worst = -1;
    const active: string[] = [];
    for (const [key, a] of this.open) {
      if (!key.startsWith(prefix)) continue;
      active.push(a.id);
      worst = Math.max(worst, SEVERITY_RANK[a.severity]);
    }
    const status = worst >= 2 ? 'critical' : worst === 1 ? 'warning' : 'normal';
    return { status, active };
  }

  /** Close everything for a device (e.g. it went offline) */
  resetDevice(tenantId: string, deviceId: string): string[] {
    const prefix = `${tenantId}|${deviceId}|`;
    const ids: string[] = [];
    for (const [key, a] of this.open) {
      if (key.startsWith(prefix)) {
        ids.push(a.id);
        this.open.delete(key);
      }
    }
    return ids;
  }
}
