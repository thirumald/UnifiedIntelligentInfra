'use client';

import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { endpoints, session } from '@/lib/api';
import { useRealtime } from '@/lib/realtime';
import { assetStatus, useTwin } from '@/lib/store';
import { AssetDetail } from './AssetDetail';
import { Sidebar } from './Sidebar';

// WebGL viewports are client-only
const MapView = dynamic(() => import('./MapView'), { ssr: false, loading: () => <div className="viewport loading">Loading map…</div> });
const BimView = dynamic(() => import('./BimView'), { ssr: false, loading: () => <div className="viewport loading">Loading BIM engine…</div> });

const CONN_LABEL = { connecting: 'Connecting', live: 'Live', reconnecting: 'Reconnecting', offline: 'Offline' } as const;

export function Console() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const view = useTwin((s) => s.view);
  const connection = useTwin((s) => s.connection);
  const assets = useTwin((s) => s.assets);
  const devices = useTwin((s) => s.devices);
  useTwin((s) => s.version);

  // Auth gate + initial load (assets, BIM models, open anomalies)
  useEffect(() => {
    if (!session.token) {
      router.replace('/login');
      return;
    }
    const { setAssets, setModels, setAnomalies } = useTwin.getState();
    Promise.all([endpoints.assets(), endpoints.bimModels(), endpoints.anomalies('hours=24&limit=200')])
      .then(([fc, models, anomalies]) => {
        setAssets(fc.features);
        setModels(models);
        setAnomalies(anomalies);
        setReady(true);
      })
      .catch((err: Error) => setError(err.message));
  }, [router]);

  useRealtime(ready);

  if (error) {
    return (
      <div className="splash">
        <h1>Unable to reach the platform API</h1>
        <p className="muted">{error}</p>
        <button className="btn" onClick={() => window.location.reload()}>
          Retry
        </button>
      </div>
    );
  }
  if (!ready) return <div className="splash">Loading digital twin…</div>;

  const counts = { normal: 0, warning: 0, critical: 0, offline: 0, unknown: 0 };
  for (const a of assets) if (a.properties.type !== 'building') counts[assetStatus(a, devices)]++;
  const { setView } = useTwin.getState();

  return (
    <div className="console">
      <header className="topbar">
        <div className="brand">
          <span className="logo">◈</span>
          <div>
            <strong>Unified Intelligent Infrastructure</strong>
            <span className="muted small">Digital Twin Operations</span>
          </div>
        </div>
        <div className="kpi-strip">
          <span>
            <b>{assets.filter((a) => a.properties.type !== 'building').length}</b> assets
          </span>
          <span className="ok">
            <b>{counts.normal}</b> normal
          </span>
          <span className="warn">
            <b>{counts.warning}</b> warning
          </span>
          <span className="crit">
            <b>{counts.critical}</b> critical
          </span>
          <span className="off">
            <b>{counts.offline}</b> offline
          </span>
        </div>
        <div className="seg view-switch" role="tablist">
          <button role="tab" aria-selected={view === 'map'} className={view === 'map' ? 'on' : ''} onClick={() => setView('map')}>
            GIS Map
          </button>
          <button role="tab" aria-selected={view === 'bim'} className={view === 'bim' ? 'on' : ''} onClick={() => setView('bim')}>
            BIM Model
          </button>
        </div>
        <div className="user">
          <span className={`conn conn-${connection}`}>● {CONN_LABEL[connection]}</span>
          <span className="muted">{session.user?.username}</span>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => {
              session.clear();
              router.replace('/login');
            }}
          >
            Sign out
          </button>
        </div>
      </header>
      <Sidebar />
      <main className="stage">{view === 'map' ? <MapView /> : <BimView />}</main>
      <AssetDetail />
    </div>
  );
}
