import type { Logger } from '@dt/common';
import type { Pool } from '@dt/db';
import type { DeviceContext, ThresholdRule } from './detector';

interface RuleRow {
  asset_id: string | null;
  asset_type: string | null;
  metric: string;
  warn_min: number | null;
  warn_max: number | null;
  crit_min: number | null;
  crit_max: number | null;
}

/**
 * In-memory read model of device → asset bindings and alert rules,
 * refreshed from PostGIS on an interval. Keeps the hot path free of
 * per-message database lookups.
 */
export class Registry {
  private devices = new Map<string, DeviceContext>();
  private assetRules = new Map<string, ThresholdRule>(); // assetId|metric
  private typeRules = new Map<string, ThresholdRule>(); // tenant|type|metric
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: Pool,
    private readonly log: Logger,
    private readonly defaults: { tempMaxC: number; rackPowerMaxKw: number },
  ) {}

  async start(refreshMs: number): Promise<void> {
    await this.refresh();
    this.timer = setInterval(() => void this.refresh().catch((err: Error) => this.log.warn({ err: err.message }, 'registry refresh failed')), refreshMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async refresh(): Promise<void> {
    const [{ rows: devs }, { rows: rules }] = await Promise.all([
      this.db.query<{ tenant_id: string; device_id: string; asset_id: string | null; asset_type: string | null }>(
        'SELECT tenant_id, device_id, asset_id, asset_type FROM v_device_bindings WHERE enabled',
      ),
      this.db.query<RuleRow & { tenant_id: string }>(
        `SELECT r.tenant_id, r.asset_id, r.asset_type, r.metric, r.warn_min, r.warn_max, r.crit_min, r.crit_max
         FROM alert_rules r WHERE r.enabled`,
      ),
    ]);
    const devices = new Map<string, DeviceContext>();
    for (const d of devs) {
      devices.set(`${d.tenant_id}|${d.device_id}`, {
        tenantId: d.tenant_id,
        deviceId: d.device_id,
        assetId: d.asset_id,
        assetType: d.asset_type,
      });
    }
    const assetRules = new Map<string, ThresholdRule>();
    const typeRules = new Map<string, ThresholdRule>();
    for (const r of rules) {
      const rule: ThresholdRule = {
        metric: r.metric,
        warnMin: r.warn_min,
        warnMax: r.warn_max,
        critMin: r.crit_min,
        critMax: r.crit_max,
      };
      if (r.asset_id) assetRules.set(`${r.asset_id}|${r.metric}`, rule);
      else if (r.asset_type) typeRules.set(`${r.tenant_id}|${r.asset_type}|${r.metric}`, rule);
    }
    this.devices = devices;
    this.assetRules = assetRules;
    this.typeRules = typeRules;
    this.log.debug({ devices: devices.size, rules: rules.length }, 'registry refreshed');
  }

  /** Unknown devices still flow (asset-less) so onboarding never drops data. */
  context(tenantId: string, deviceId: string): DeviceContext {
    return this.devices.get(`${tenantId}|${deviceId}`) ?? { tenantId, deviceId, assetId: null, assetType: null };
  }

  rule = (ctx: DeviceContext, metric: string): ThresholdRule | null => {
    if (ctx.assetId) {
      const r = this.assetRules.get(`${ctx.assetId}|${metric}`);
      if (r) return r;
    }
    if (ctx.assetType) {
      const r = this.typeRules.get(`${ctx.tenantId}|${ctx.assetType}|${metric}`);
      if (r) return r;
    }
    // Platform defaults from env — safety net for unconfigured tenants
    if (metric === 'temperature_c' || metric === 'inlet_temp_c') {
      return { metric, warnMin: null, warnMax: this.defaults.tempMaxC, critMin: null, critMax: this.defaults.tempMaxC + 5 };
    }
    if (metric === 'power_kw' && ctx.assetType === 'server_rack') {
      return { metric, warnMin: null, warnMax: this.defaults.rackPowerMaxKw, critMin: null, critMax: this.defaults.rackPowerMaxKw * 1.2 };
    }
    return null;
  };
}
