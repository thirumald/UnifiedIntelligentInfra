'use client';

import type { AnomalyEvent, AssetFeature, DeviceStateSnapshot } from '@dt/contracts';
import { create } from 'zustand';
import type { AnomalyRow, BimModel } from './api';

export type ViewMode = 'map' | 'bim';
export type LiveStatus = DeviceStateSnapshot['status'] | 'unknown';
export type ConnectionState = 'connecting' | 'live' | 'reconnecting' | 'offline';

const STATUS_RANK: Record<LiveStatus, number> = { unknown: -1, normal: 0, offline: 1, warning: 2, critical: 3 };

interface TwinState {
  assets: AssetFeature[];
  assetsById: Map<string, AssetFeature>;
  /** deviceId → assetId (derived from asset.properties.deviceIds) */
  deviceToAsset: Map<string, string>;
  /** deviceId → latest snapshot */
  devices: Map<string, DeviceStateSnapshot>;
  /** bumps on every live update — cheap dependency for renderers */
  version: number;
  models: BimModel[];
  anomalies: AnomalyRow[];
  selectedAssetId: string | null;
  selectedModelId: string | null;
  view: ViewMode;
  connection: ConnectionState;
  filter: { text: string; domain: string | null; onlyAlerts: boolean };

  setAssets(a: AssetFeature[]): void;
  setModels(m: BimModel[]): void;
  setAnomalies(a: AnomalyRow[]): void;
  applySnapshot(states: DeviceStateSnapshot[], replace?: boolean): void;
  pushAnomaly(a: AnomalyEvent): void;
  markAcknowledged(id: string, by: string): void;
  select(assetId: string | null): void;
  selectModel(id: string | null): void;
  setView(v: ViewMode): void;
  setConnection(c: ConnectionState): void;
  setFilter(f: Partial<TwinState['filter']>): void;
}

export const useTwin = create<TwinState>((set, get) => ({
  assets: [],
  assetsById: new Map(),
  deviceToAsset: new Map(),
  devices: new Map(),
  version: 0,
  models: [],
  anomalies: [],
  selectedAssetId: null,
  selectedModelId: null,
  view: 'map',
  connection: 'connecting',
  filter: { text: '', domain: null, onlyAlerts: false },

  setAssets: (assets) => {
    const deviceToAsset = new Map<string, string>();
    for (const a of assets) for (const d of a.properties.deviceIds) deviceToAsset.set(d, a.id);
    set({ assets, assetsById: new Map(assets.map((a) => [a.id, a])), deviceToAsset });
  },
  setModels: (models) => set((s) => ({ models, selectedModelId: s.selectedModelId ?? models[0]?.id ?? null })),
  setAnomalies: (anomalies) => set({ anomalies }),

  applySnapshot: (states, replace = false) => {
    const devices = replace ? new Map<string, DeviceStateSnapshot>() : new Map(get().devices);
    for (const s of states) devices.set(s.deviceId, s);
    set((st) => ({ devices, version: st.version + 1 }));
  },

  pushAnomaly: (a) =>
    set((s) => {
      if (s.anomalies.some((x) => x.anomalyId === a.anomalyId)) return {};
      const row: AnomalyRow = {
        anomalyId: a.anomalyId,
        time: new Date(a.ts).toISOString(),
        deviceId: a.deviceId,
        assetId: a.assetId,
        metric: a.metric,
        value: a.value,
        detector: a.detector,
        severity: a.severity,
        threshold: a.threshold,
        message: a.message,
        acknowledgedAt: null,
        acknowledgedBy: null,
        resolvedAt: null,
      };
      return { anomalies: [row, ...s.anomalies].slice(0, 300) };
    }),

  markAcknowledged: (id, by) =>
    set((s) => ({
      anomalies: s.anomalies.map((a) => (a.anomalyId === id ? { ...a, acknowledgedAt: new Date().toISOString(), acknowledgedBy: by } : a)),
    })),

  select: (selectedAssetId) => {
    const asset = selectedAssetId ? get().assetsById.get(selectedAssetId) : null;
    set((s) => ({ selectedAssetId, selectedModelId: asset?.properties.bim?.modelId ?? s.selectedModelId }));
  },
  selectModel: (selectedModelId) => set({ selectedModelId }),
  setView: (view) => set({ view }),
  setConnection: (connection) => set({ connection }),
  setFilter: (f) => set((s) => ({ filter: { ...s.filter, ...f } })),
}));

/** Worst live status across every device bound to an asset */
export function assetStatus(asset: AssetFeature, devices: Map<string, DeviceStateSnapshot>): LiveStatus {
  let worst: LiveStatus = 'unknown';
  for (const d of asset.properties.deviceIds) {
    const s = devices.get(d)?.status;
    if (s && STATUS_RANK[s] > STATUS_RANK[worst]) worst = s;
  }
  return worst;
}

/** Merged live metrics for an asset (multi-device assets merge, newest wins) */
export function assetMetrics(asset: AssetFeature, devices: Map<string, DeviceStateSnapshot>) {
  const snaps = asset.properties.deviceIds
    .map((d) => devices.get(d))
    .filter((s): s is DeviceStateSnapshot => !!s)
    .sort((a, b) => a.ts - b.ts);
  const metrics: Record<string, number | boolean | string> = {};
  for (const s of snaps) Object.assign(metrics, s.metrics);
  return { metrics, ts: snaps.at(-1)?.ts ?? null };
}
