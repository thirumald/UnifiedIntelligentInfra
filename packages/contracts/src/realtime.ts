import type { AnomalyEvent, DeviceStateSnapshot } from './telemetry.js';

/**
 * socket.io event contract between the API gateway (server) and the spatial
 * UI (client). Typed on both ends: Server<ClientToServer, ServerToClient>.
 */

/** Viewport subscription — server only pushes devices inside the bbox. */
export interface ViewportSubscription {
  /** [minLon, minLat, maxLon, maxLat] */
  bbox?: [number, number, number, number];
  /** Explicit asset filter (e.g. the BIM model currently open) */
  assetIds?: string[];
  /** Min status to receive; 'normal' = everything */
  minStatus?: DeviceStateSnapshot['status'];
}

export interface ServerToClientEvents {
  /** Batched device state deltas (coalesced server-side, ≤ 10 Hz) */
  'state:batch': (states: DeviceStateSnapshot[]) => void;
  /** Immediate, un-throttled anomaly push */
  'anomaly': (event: AnomalyEvent) => void;
  /** Full snapshot sent once after subscribe for rehydration */
  'state:snapshot': (states: DeviceStateSnapshot[]) => void;
  'server:error': (err: { code: string; message: string }) => void;
}

export interface ClientToServerEvents {
  'subscribe': (sub: ViewportSubscription, ack: (res: { ok: boolean; devices: number }) => void) => void;
  'unsubscribe': () => void;
}

export interface SocketData {
  tenantId: string;
  userId: string;
  subscription: ViewportSubscription | null;
}

export const REALTIME_NAMESPACE = '/twin';
