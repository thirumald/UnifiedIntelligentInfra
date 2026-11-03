'use client';

import { useEffect, useMemo, useState } from 'react';
import { endpoints, session, type SeriesResponse } from '@/lib/api';
import { assetMetrics, assetStatus, useTwin } from '@/lib/store';
import { DOMAIN_LABELS, KEY_METRICS, STATUS_COLORS, TYPE_ICON, formatMetric, metricLabel } from '@/lib/theme';
import { Sparkline } from './Sparkline';

const WINDOWS = [
  { label: '15m', ms: 15 * 60_000 },
  { label: '1h', ms: 3_600_000 },
  { label: '24h', ms: 86_400_000 },
  { label: '7d', ms: 7 * 86_400_000 },
];

export function AssetDetail() {
  const id = useTwin((s) => s.selectedAssetId);
  const asset = useTwin((s) => (id ? s.assetsById.get(id) : undefined));
  const devices = useTwin((s) => s.devices);
  useTwin((s) => s.version);
  const anomalies = useTwin((s) => s.anomalies);

  const [metric, setMetric] = useState<string | null>(null);
  const [windowMs, setWindowMs] = useState(WINDOWS[1]!.ms);
  const [series, setSeries] = useState<SeriesResponse | null>(null);

  const live = asset ? assetMetrics(asset, devices) : null;
  const numericMetrics = useMemo(() => {
    if (!asset || !live) return [];
    const preferred = KEY_METRICS[asset.properties.type] ?? [];
    const all = Object.entries(live.metrics).filter(([, v]) => typeof v === 'number').map(([k]) => k);
    return [...preferred.filter((m) => all.includes(m)), ...all.filter((m) => !preferred.includes(m))];
  }, [asset, live]);

  // Default chart metric = first key metric with numeric data
  useEffect(() => {
    setMetric(null);
    setSeries(null);
  }, [id]);
  useEffect(() => {
    if (!metric && numericMetrics.length) setMetric(numericMetrics[0]!);
  }, [metric, numericMetrics]);

  // History from TimescaleDB; refresh periodically so the chart follows live data
  useEffect(() => {
    if (!asset || !metric) return;
    let cancelled = false;
    const load = () =>
      endpoints
        .series(asset.id, metric, Date.now() - windowMs)
        .then((r) => !cancelled && setSeries(r))
        .catch(() => undefined);
    void load();
    const timer = setInterval(load, windowMs <= 3_600_000 ? 10_000 : 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [asset?.id, metric, windowMs]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!asset || !live) {
    return (
      <aside className="detail empty-detail">
        <p>Select an asset on the map, in the BIM model, or from the list to see live telemetry, history and alerts.</p>
      </aside>
    );
  }

  const p = asset.properties;
  const status = assetStatus(asset, devices);
  const assetAnomalies = anomalies.filter((a) => a.assetId === asset.id).slice(0, 8);
  const keyMetrics = KEY_METRICS[p.type] ?? Object.keys(live.metrics).slice(0, 4);
  const otherMetrics = Object.keys(live.metrics).filter((m) => !keyMetrics.includes(m));
  const [lon, lat, alt] = asset.geometry.coordinates;
  const { select, setView, selectModel } = useTwin.getState();

  const ack = async (anomalyId: string) => {
    await endpoints.ack(anomalyId);
    useTwin.getState().markAcknowledged(anomalyId, session.user?.username ?? 'me');
  };

  return (
    <aside className="detail">
      <header className="detail-head">
        <div>
          <div className="eyebrow">
            {TYPE_ICON[p.type]} {p.type.replace(/_/g, ' ')} · {DOMAIN_LABELS[p.domain]}
          </div>
          <h2>{p.name}</h2>
          <div className="muted mono">{p.externalId ?? asset.id.slice(0, 8)}</div>
        </div>
        <button className="icon-btn" aria-label="Close" onClick={() => select(null)}>
          ✕
        </button>
      </header>

      <div className="status-row">
        <span className="status-chip" style={{ background: STATUS_COLORS[status].css }}>
          {STATUS_COLORS[status].label}
        </span>
        <span className="muted">{live.ts ? `Updated ${new Date(live.ts).toLocaleTimeString()}` : 'Awaiting telemetry'}</span>
      </div>

      <section className="kpis">
        {keyMetrics.map((m) => (
          <button key={m} className={`kpi ${metric === m ? 'active' : ''}`} onClick={() => typeof live.metrics[m] === 'number' && setMetric(m)}>
            <span className="kpi-label">{metricLabel(m)}</span>
            <span className="kpi-value">{formatMetric(m, live.metrics[m])}</span>
          </button>
        ))}
      </section>

      {metric && (
        <section className="card">
          <div className="card-head">
            <select value={metric} onChange={(e) => setMetric(e.target.value)}>
              {numericMetrics.map((m) => (
                <option key={m} value={m}>
                  {metricLabel(m)}
                </option>
              ))}
            </select>
            <div className="seg">
              {WINDOWS.map((w) => (
                <button key={w.label} className={w.ms === windowMs ? 'on' : ''} onClick={() => setWindowMs(w.ms)}>
                  {w.label}
                </button>
              ))}
            </div>
          </div>
          <Sparkline points={series?.metric === metric ? series.points : []} format={(v) => formatMetric(metric, Number(v.toFixed(2)))} />
          {series?.resolution && <div className="muted small">Resolution {series.resolution} · TimescaleDB</div>}
        </section>
      )}

      {otherMetrics.length > 0 && (
        <section className="card">
          <h3>All signals</h3>
          <dl className="kv">
            {otherMetrics.map((m) => (
              <div key={m}>
                <dt>{metricLabel(m)}</dt>
                <dd>{formatMetric(m, live.metrics[m])}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      <section className="card">
        <h3>Alerts</h3>
        {assetAnomalies.length === 0 && <p className="muted small">No alerts in the last 24 hours.</p>}
        <ul className="alerts">
          {assetAnomalies.map((a) => (
            <li key={a.anomalyId} className={`sev-${a.severity}`}>
              <div>
                <strong>{a.message}</strong>
                <span className="muted small">
                  {new Date(a.time).toLocaleString()} · {a.detector}
                  {a.resolvedAt ? ' · resolved' : ''}
                </span>
              </div>
              {!a.acknowledgedAt && !a.resolvedAt && session.canWrite() ? (
                <button className="btn btn-sm" onClick={() => void ack(a.anomalyId)}>
                  Ack
                </button>
              ) : a.acknowledgedAt ? (
                <span className="muted small">✓ {a.acknowledgedBy}</span>
              ) : null}
            </li>
          ))}
        </ul>
      </section>

      <section className="card">
        <h3>Placement</h3>
        <dl className="kv">
          <div>
            <dt>WGS84</dt>
            <dd className="mono">
              {lat.toFixed(6)}, {lon.toFixed(6)}
              {alt !== undefined ? ` · ${alt} m` : ''}
            </dd>
          </div>
          {p.bim && (
            <>
              <div>
                <dt>IFC GlobalId</dt>
                <dd className="mono">{p.bim.ifcGuid}</dd>
              </div>
              <div>
                <dt>IFC class</dt>
                <dd>{p.bim.ifcClass ?? '—'}</dd>
              </div>
              <div>
                <dt>Storey · local</dt>
                <dd className="mono">
                  {p.bim.storey ?? '—'} · ({p.bim.local.x}, {p.bim.local.y}, {p.bim.local.z})
                </dd>
              </div>
            </>
          )}
          <div>
            <dt>Devices</dt>
            <dd className="mono">{p.deviceIds.join(', ') || '—'}</dd>
          </div>
        </dl>
        <div className="row-btns">
          <button className="btn btn-ghost" onClick={() => setView('map')}>
            Show on map
          </button>
          {p.bim && (
            <button
              className="btn btn-ghost"
              onClick={() => {
                selectModel(p.bim!.modelId);
                setView('bim');
              }}
            >
              Show in BIM
            </button>
          )}
        </div>
      </section>

      {Object.keys(p.attributes).length > 0 && (
        <section className="card">
          <h3>Attributes</h3>
          <dl className="kv">
            {Object.entries(p.attributes).map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? JSON.stringify(v) : String(v)}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}
    </aside>
  );
}
