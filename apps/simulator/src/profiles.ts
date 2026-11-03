import type { Reading } from '@dt/contracts';

/**
 * Device behaviour profiles. Each tick returns a payload in the device's
 * native format: most speak the canonical JSON contract; BACnet AHUs and
 * the Modbus pump PLC emit vendor payloads that the ingest bridge maps via
 * the dynamic schema mappings seeded in PostGIS.
 */

export interface SimState {
  /** 0..1 — active fault intensity (0 = healthy) */
  fault: number;
  /** remaining fault ticks */
  faultTicks: number;
  phase: number;
  counter: number;
}

const noise = (amp: number) => (Math.random() - 0.5) * 2 * amp;
const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

/** Hour-of-day load curve (Gulf office building — peaks early afternoon) */
function dayLoad(now: Date): number {
  const h = now.getUTCHours() + 4 + now.getUTCMinutes() / 60; // GST
  return 0.5 + 0.5 * Math.sin(((h - 8) / 24) * 2 * Math.PI);
}

const canonical = (readings: Reading[], ts: number) => ({ ts, readings });

export type Profile = (s: SimState, now: Date) => unknown;

export const profiles: Record<string, Profile> = {
  hvac: (s, now) => {
    const t = 21.5 + dayLoad(now) * 1.5 + s.fault * 9 + noise(0.25);
    return canonical(
      [
        { metric: 'temperature_c', value: round(t), unit: 'C', quality: 'good' },
        { metric: 'humidity_pct', value: round(45 + noise(3)), unit: '%', quality: 'good' },
        { metric: 'supply_air_temp_c', value: round(14 + s.fault * 6 + noise(0.3)), unit: 'C', quality: 'good' },
        { metric: 'fan_speed_pct', value: round(55 + dayLoad(now) * 25 + s.fault * 20 + noise(2), 1), unit: '%', quality: 'good' },
        { metric: 'compressor_kw', value: round(18 + dayLoad(now) * 10 + noise(1)), unit: 'kW', quality: 'good' },
      ],
      now.getTime(),
    );
  },

  // BACnet/IP rooftop AHU → vendor object dump (mapped by "bacnet-ahu-v1")
  hvac_bacnet: (s, now) => ({
    deviceInstance: 2001,
    timestamp: Math.floor(now.getTime() / 1000),
    objects: {
      'ZN-T': { objectType: 'analog-input', presentValue: Math.round((23 + dayLoad(now) * 3 + s.fault * 8 + noise(0.3)) * 10) },
      'SA-T': { objectType: 'analog-input', presentValue: Math.round((13 + s.fault * 5 + noise(0.3)) * 10) },
      'FAN-SPD': { objectType: 'analog-output', presentValue: Math.round(60 + dayLoad(now) * 30 + noise(2)) },
      ALM: { objectType: 'binary-input', presentValue: s.fault > 0.6 ? 'active' : 'inactive' },
    },
  }),

  rack: (s, now) =>
    canonical(
      [
        { metric: 'power_kw', value: round(4.2 + dayLoad(now) * 2.2 + s.fault * 4 + noise(0.2)), unit: 'kW', quality: 'good' },
        { metric: 'inlet_temp_c', value: round(22 + s.fault * 12 + noise(0.4)), unit: 'C', quality: 'good' },
        { metric: 'outlet_temp_c', value: round(34 + dayLoad(now) * 4 + s.fault * 8 + noise(0.5)), unit: 'C', quality: 'good' },
      ],
      now.getTime(),
    ),

  pdu: (s, now) => {
    const current = 14 + dayLoad(now) * 6 + s.fault * 14 + noise(0.6);
    return canonical(
      [
        { metric: 'current_a', value: round(current), unit: 'A', quality: 'good' },
        { metric: 'voltage_v', value: round(230 + noise(1.5), 1), unit: 'V', quality: 'good' },
        { metric: 'power_kw', value: round((current * 230 * 1.732) / 1000), unit: 'kW', quality: 'good' },
      ],
      now.getTime(),
    );
  },

  ups: (s, now) =>
    canonical(
      [
        { metric: 'load_pct', value: round(48 + dayLoad(now) * 15 + s.fault * 40 + noise(1), 1), unit: '%', quality: 'good' },
        { metric: 'battery_pct', value: round(Math.max(5, 100 - s.fault * 75 + noise(0.5)), 1), unit: '%', quality: 'good' },
        { metric: 'on_battery', value: s.fault > 0.5, quality: 'good' },
      ],
      now.getTime(),
    ),

  switch: (s, now) =>
    canonical(
      [
        { metric: 'cpu_pct', value: round(22 + dayLoad(now) * 20 + s.fault * 70 + noise(3), 1), unit: '%', quality: 'good' },
        { metric: 'throughput_gbps', value: round(3 + dayLoad(now) * 12 + noise(0.5)), unit: 'Gbps', quality: 'good' },
        { metric: 'ports_up', value: 46 - Math.round(s.fault * 6), quality: 'good' },
      ],
      now.getTime(),
    ),

  env: (s, now) =>
    canonical(
      [
        { metric: 'temperature_c', value: round(22.5 + s.fault * 7 + noise(0.2)), unit: 'C', quality: 'good' },
        { metric: 'humidity_pct', value: round(46 + s.fault * 22 + noise(1.5), 1), unit: '%', quality: 'good' },
      ],
      now.getTime(),
    ),

  cctv: (s, now) =>
    canonical(
      [
        { metric: 'online', value: s.fault < 0.8, quality: 'good' },
        { metric: 'bitrate_mbps', value: s.fault >= 0.8 ? 0 : round(6 + noise(0.8)), unit: 'Mbps', quality: 'good' },
        { metric: 'motion_events', value: Math.max(0, Math.round(dayLoad(now) * 4 + noise(2))), quality: 'good' },
      ],
      now.getTime(),
    ),

  streetlight: (s, now) => {
    const h = (now.getUTCHours() + 4) % 24;
    const on = h >= 18 || h < 6;
    return canonical(
      [
        { metric: 'lamp_on', value: on, quality: 'good' },
        { metric: 'power_w', value: round(on ? 118 + s.fault * 50 + noise(2) : 1.5 + noise(0.2), 1), unit: 'W', quality: 'good' },
        { metric: 'lux', value: round(on ? 35 + noise(2) : 0, 1), unit: 'lx', quality: 'good' },
      ],
      now.getTime(),
    );
  },

  // Modbus/TCP PLC → raw holding registers (mapped by "modbus-pump-v1")
  plc: (s, now) => ({
    unitId: 1,
    t: now.getTime(),
    registers: {
      '40001': Math.round((4.2 + Math.sin(s.phase) * 0.4 - s.fault * 3.2 + noise(0.05)) * 100),
      '40002': Math.round((120 + Math.sin(s.phase) * 15 - s.fault * 80 + noise(2)) * 10),
      '40003': s.fault > 0.7 ? 0 : 1,
    },
  }),

  rtu: (s, now) =>
    canonical(
      [
        { metric: 'reservoir_level_pct', value: round(70 + Math.sin(s.phase / 4) * 15 - s.fault * 55 + noise(0.3), 1), unit: '%', quality: 'good' },
        { metric: 'chlorine_mg_l', value: round(0.8 + noise(0.05)), unit: 'mg/L', quality: 'good' },
      ],
      now.getTime(),
    ),

  signal: (s, now) =>
    canonical(
      [
        { metric: 'phase', value: ['NS_GREEN', 'NS_AMBER', 'EW_GREEN', 'EW_AMBER'][s.counter % 4]!, quality: 'good' },
        { metric: 'queue_length', value: Math.max(0, Math.round(dayLoad(now) * 18 + noise(3))), quality: 'good' },
        { metric: 'fault', value: s.fault > 0.7, quality: 'good' },
      ],
      now.getTime(),
    ),
};

export const DEFAULT_PROFILE = 'env';
