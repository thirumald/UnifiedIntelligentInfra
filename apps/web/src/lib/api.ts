import type { AssetFeature, AssetFeatureCollection } from '@dt/contracts';
import { config } from './config';

/* ----------------------------------- auth ---------------------------------- */

const TOKEN_KEY = 'dt.token';
const USER_KEY = 'dt.user';

export interface SessionUser {
  username: string;
  roles: string[];
  tenantId: string;
}

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export const session = {
  get token(): string | null {
    return storage()?.getItem(TOKEN_KEY) ?? null;
  },
  get user(): SessionUser | null {
    const raw = storage()?.getItem(USER_KEY);
    try {
      return raw ? (JSON.parse(raw) as SessionUser) : null;
    } catch {
      return null;
    }
  },
  set(token: string, user: SessionUser) {
    storage()?.setItem(TOKEN_KEY, token);
    storage()?.setItem(USER_KEY, JSON.stringify(user));
  },
  clear() {
    storage()?.removeItem(TOKEN_KEY);
    storage()?.removeItem(USER_KEY);
  },
  canWrite(): boolean {
    return !!this.user?.roles.some((r) => r === 'admin' || r === 'operator');
  },
};

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/* --------------------------------- transport -------------------------------- */

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (session.token) headers.set('authorization', `Bearer ${session.token}`);
  if (init.body && !(init.body instanceof FormData) && !headers.has('content-type')) headers.set('content-type', 'application/json');

  const res = await fetch(`${config.apiUrl}${path}`, { ...init, headers });
  if (res.status === 401 && typeof window !== 'undefined' && !path.startsWith('/auth/')) {
    session.clear();
    window.location.assign('/login');
  }
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = (await res.json()) as { message?: string | string[]; issues?: { path: string; message: string }[] };
      message = body.issues?.map((i) => `${i.path}: ${i.message}`).join('; ') || [body.message].flat().join('; ') || message;
    } catch {
      /* non-JSON error */
    }
    throw new ApiError(res.status, message);
  }
  if (res.status === 204) return undefined as T;
  const type = res.headers.get('content-type') ?? '';
  return (type.includes('application/json') ? res.json() : res.arrayBuffer()) as Promise<T>;
}

/* ---------------------------------- types ---------------------------------- */

export interface BimModel {
  id: string;
  name: string;
  lon: number;
  lat: number;
  originAltM: number;
  rotationDeg: number;
  widthM: number;
  depthM: number;
  storeys: { name: string; elevation_m: number; height_m: number }[];
  ifcSchema: string | null;
  fileSize: number | null;
  status: 'schematic' | 'uploaded' | 'processing' | 'ready' | 'failed';
  elementCount: number;
  error: string | null;
  assetCount: number;
}

export interface BimElement {
  ifcGuid: string;
  expressId: number;
  ifcClass: string;
  name: string | null;
  storey: string | null;
}

export interface AnomalyRow {
  anomalyId: string;
  time: string;
  deviceId: string;
  assetId: string | null;
  metric: string;
  value: number;
  detector: string;
  severity: 'info' | 'warning' | 'critical';
  threshold: number | null;
  message: string;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  resolvedAt: string | null;
}

export interface SeriesResponse {
  metric: string;
  resolution: string | null;
  points: { t: number; avg: number; min: number; max: number }[];
}

/* -------------------------------- endpoints -------------------------------- */

export const endpoints = {
  login: (username: string, password: string) =>
    api<{ accessToken: string; user: SessionUser }>('/auth/token', { method: 'POST', body: JSON.stringify({ username, password }) }),
  assets: () => api<AssetFeatureCollection>('/assets?limit=5000'),
  asset: (id: string) => api<AssetFeature>(`/assets/${id}`),
  bimModels: () => api<BimModel[]>('/bim-models'),
  bimElements: (id: string) => api<BimElement[]>(`/bim-models/${id}/elements`),
  bimFile: (id: string) => api<ArrayBuffer>(`/bim-models/${id}/file`),
  uploadIfc: (form: FormData) => api<BimModel>('/bim-models', { method: 'POST', body: form }),
  anomalies: (q = 'open=true&hours=24') => api<AnomalyRow[]>(`/anomalies?${q}`),
  ack: (id: string) => api<{ acknowledged: boolean }>(`/anomalies/${id}/ack`, { method: 'POST' }),
  metrics: (assetId: string) => api<{ metric: string; unit: string | null }[]>(`/telemetry/metrics?assetId=${assetId}`),
  series: (assetId: string, metric: string, fromMs: number) =>
    api<SeriesResponse>(`/telemetry/series?assetId=${assetId}&metric=${metric}&from=${new Date(fromMs).toISOString()}`),
};
