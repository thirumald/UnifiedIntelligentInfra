'use client';

import { useMemo, useState } from 'react';
import { endpoints, session } from '@/lib/api';
import { assetStatus, useTwin } from '@/lib/store';
import { DOMAIN_LABELS, STATUS_COLORS, TYPE_ICON } from '@/lib/theme';

const STATUS_ORDER = { critical: 0, warning: 1, offline: 2, normal: 3, unknown: 4 } as const;

export function Sidebar() {
  const [tab, setTab] = useState<'assets' | 'alerts'>('assets');
  const assets = useTwin((s) => s.assets);
  const devices = useTwin((s) => s.devices);
  const version = useTwin((s) => s.version);
  const anomalies = useTwin((s) => s.anomalies);
  const selectedId = useTwin((s) => s.selectedAssetId);
  const filter = useTwin((s) => s.filter);
  const { select, setFilter } = useTwin.getState();

  const rows = useMemo(() => {
    const text = filter.text.trim().toLowerCase();
    return assets
      .filter((a) => a.properties.type !== 'building')
      .filter((a) => !filter.domain || a.properties.domain === filter.domain)
      .filter((a) => !text || a.properties.name.toLowerCase().includes(text) || (a.properties.externalId ?? '').toLowerCase().includes(text))
      .map((a) => ({ a, status: assetStatus(a, devices) }))
      .filter((r) => !filter.onlyAlerts || r.status === 'critical' || r.status === 'warning')
      .sort((x, y) => STATUS_ORDER[x.status] - STATUS_ORDER[y.status] || x.a.properties.name.localeCompare(y.a.properties.name));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assets, version, filter]);

  const open = anomalies.filter((a) => !a.resolvedAt);
  const unacked = open.filter((a) => !a.acknowledgedAt).length;

  return (
    <nav className="sidebar">
      <div className="tabs">
        <button className={tab === 'assets' ? 'on' : ''} onClick={() => setTab('assets')}>
          Assets <span className="count">{rows.length}</span>
        </button>
        <button className={tab === 'alerts' ? 'on' : ''} onClick={() => setTab('alerts')}>
          Alerts {unacked > 0 && <span className="count hot">{unacked}</span>}
        </button>
      </div>

      {tab === 'assets' && (
        <>
          <div className="filters">
            <input type="search" placeholder="Search name or ID…" value={filter.text} onChange={(e) => setFilter({ text: e.target.value })} aria-label="Search assets" />
            <div className="chips">
              <button className={!filter.domain ? 'on' : ''} onClick={() => setFilter({ domain: null })}>
                All
              </button>
              {Object.entries(DOMAIN_LABELS).map(([k, v]) => (
                <button key={k} className={filter.domain === k ? 'on' : ''} onClick={() => setFilter({ domain: filter.domain === k ? null : k })}>
                  {v}
                </button>
              ))}
            </div>
            <label className="toggle">
              <input type="checkbox" checked={filter.onlyAlerts} onChange={(e) => setFilter({ onlyAlerts: e.target.checked })} /> Only warning / critical
            </label>
          </div>
          <ul className="asset-list">
            {rows.map(({ a, status }) => (
              <li key={a.id}>
                <button className={a.id === selectedId ? 'sel' : ''} onClick={() => select(a.id)}>
                  <i className="dot" style={{ background: STATUS_COLORS[status].css }} />
                  <span className="icon">{TYPE_ICON[a.properties.type]}</span>
                  <span className="name">{a.properties.name}</span>
                  <span className="muted mono small">{a.properties.externalId}</span>
                </button>
              </li>
            ))}
            {rows.length === 0 && <li className="muted small pad">No assets match.</li>}
          </ul>
        </>
      )}

      {tab === 'alerts' && (
        <ul className="alerts feed">
          {anomalies.length === 0 && <li className="muted small pad">No alerts in the last 24 hours.</li>}
          {anomalies.map((a) => (
            <li key={a.anomalyId} className={`sev-${a.severity} ${a.resolvedAt ? 'resolved' : ''}`}>
              <button className="feed-body" onClick={() => a.assetId && select(a.assetId)}>
                <strong>{a.message}</strong>
                <span className="muted small">
                  {a.deviceId} · {new Date(a.time).toLocaleTimeString()}
                  {a.resolvedAt ? ' · resolved' : ''}
                </span>
              </button>
              {!a.acknowledgedAt && !a.resolvedAt && session.canWrite() && (
                <button
                  className="btn btn-sm"
                  onClick={async () => {
                    await endpoints.ack(a.anomalyId);
                    useTwin.getState().markAcknowledged(a.anomalyId, session.user?.username ?? 'me');
                  }}
                >
                  Ack
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </nav>
  );
}
