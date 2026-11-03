import type { AssetFeature } from '@dt/contracts';
import type { LiveStatus } from './store';

/** Status palette — shared by map (RGBA arrays), BIM (hex) and UI (CSS). */
export const STATUS_COLORS: Record<LiveStatus, { rgb: [number, number, number]; hex: number; css: string; label: string }> = {
  normal: { rgb: [46, 204, 138], hex: 0x2ecc8a, css: '#2ecc8a', label: 'Normal' },
  warning: { rgb: [245, 166, 35], hex: 0xf5a623, css: '#f5a623', label: 'Warning' },
  critical: { rgb: [239, 68, 68], hex: 0xef4444, css: '#ef4444', label: 'Critical' },
  offline: { rgb: [120, 128, 140], hex: 0x78808c, css: '#78808c', label: 'Offline' },
  unknown: { rgb: [96, 140, 210], hex: 0x608cd2, css: '#608cd2', label: 'No data' },
};

export const DOMAIN_LABELS: Record<string, string> = {
  it: 'IT',
  ot: 'OT / SCADA',
  facility: 'Facility',
  safety: 'Safety & Security',
  mobility: 'Mobility',
};

export const TYPE_ICON: Record<string, string> = {
  hvac_unit: '❄',
  server_rack: '▤',
  network_switch: '⇄',
  pdu: '⚡',
  ups: '🔋',
  cctv_camera: '◉',
  plc: '⚙',
  scada_rtu: '📡',
  sensor: '◎',
  access_controller: '🔒',
  streetlight: '💡',
  traffic_signal: '🚦',
  building: '🏢',
  floor: '▭',
  room: '▢',
  other: '•',
};

/** Physical size (metres) used for BIM schematic boxes */
export const TYPE_BOX: Record<string, [number, number, number]> = {
  hvac_unit: [2.4, 1.2, 2.0],
  server_rack: [0.6, 1.2, 2.0],
  network_switch: [0.6, 0.8, 0.4],
  pdu: [0.4, 0.4, 1.8],
  ups: [1.8, 0.9, 2.0],
  sensor: [0.3, 0.3, 0.3],
  other: [0.8, 0.8, 0.8],
};

/** Metrics shown first in the detail panel per asset type */
export const KEY_METRICS: Record<string, string[]> = {
  hvac_unit: ['temperature_c', 'supply_air_temp_c', 'fan_speed_pct', 'humidity_pct'],
  server_rack: ['power_kw', 'inlet_temp_c', 'outlet_temp_c'],
  pdu: ['current_a', 'power_kw', 'voltage_v'],
  ups: ['load_pct', 'battery_pct', 'on_battery'],
  network_switch: ['cpu_pct', 'throughput_gbps', 'ports_up'],
  sensor: ['temperature_c', 'humidity_pct'],
  cctv_camera: ['online', 'bitrate_mbps', 'motion_events'],
  streetlight: ['lamp_on', 'power_w', 'lux'],
  plc: ['pressure_bar', 'flow_m3h', 'pump_running'],
  scada_rtu: ['reservoir_level_pct', 'chlorine_mg_l'],
  traffic_signal: ['phase', 'queue_length', 'fault'],
};

export function formatMetric(name: string, value: number | boolean | string | undefined): string {
  if (value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'string') return value;
  const unit = name.endsWith('_c') ? ' °C' : name.endsWith('_pct') ? ' %' : name.endsWith('_kw') ? ' kW' : name.endsWith('_w') ? ' W' : name.endsWith('_a') ? ' A' : name.endsWith('_v') ? ' V' : name.endsWith('_bar') ? ' bar' : name.endsWith('_m3h') ? ' m³/h' : name.endsWith('_mbps') ? ' Mbps' : name.endsWith('_gbps') ? ' Gbps' : '';
  return `${Number.isInteger(value) ? value : value.toFixed(value < 10 ? 2 : 1)}${unit}`;
}

export const metricLabel = (m: string) =>
  m
    .replace(/_(c|pct|kw|w|a|v|bar|m3h|mbps|gbps|mg_l)$/, '')
    .replace(/_/g, ' ')
    .replace(/^\w/, (c) => c.toUpperCase());

export function isBimAsset(a: AssetFeature): boolean {
  return !!a.properties.bim;
}
