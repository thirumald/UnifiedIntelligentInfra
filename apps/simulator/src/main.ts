/**
 * IoT / OT device simulator.
 * Discovers devices from the API (so markers on the map and BIM objects
 * light up), then publishes realistic telemetry over MQTT with periodic
 * injected fault episodes that exercise the anomaly pipeline end to end.
 */
import { createLogger, envs, loadEnv, onShutdown, retry, sleep } from '@dt/common';
import { mqttTopic } from '@dt/contracts';
import jwt from 'jsonwebtoken';
import mqtt from 'mqtt';
import { z } from 'zod';
import { DEFAULT_PROFILE, profiles, type SimState } from './profiles';

const env = loadEnv(
  z.object({
    API_INTERNAL_URL: envs.str('http://api:4000/api/v1'),
    JWT_SECRET: z.string().min(32),
    JWT_ISSUER: envs.str('dt-platform'),
    JWT_AUDIENCE: envs.str('dt-platform-clients'),
    TENANT_ID: envs.str('default'),
    MQTT_URL: envs.str('mqtt://mosquitto:1883'),
    MQTT_DEVICE_USERNAME: envs.str('dt-device'),
    MQTT_DEVICE_PASSWORD: envs.str(),
    MQTT_TOPIC_ROOT: envs.str('dt/v1'),
    SIM_PUBLISH_INTERVAL_MS: envs.int(2000),
    /** Per-device probability per tick of starting a fault episode */
    SIM_ANOMALY_PROBABILITY: envs.num(0.004),
    /** Extra synthetic devices beyond those registered (0 = registry only) */
    SIM_DEVICE_COUNT: envs.int(0),
  }),
);

const log = createLogger('simulator');

interface Device {
  id: string;
  profile: string | null;
}

async function discoverDevices(): Promise<Device[]> {
  // Short-lived service token, signed with the platform secret
  const token = jwt.sign({ tenantId: env.TENANT_ID, roles: ['viewer'] }, env.JWT_SECRET, {
    subject: 'svc-simulator',
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
    expiresIn: 300,
  });
  const res = await fetch(`${env.API_INTERNAL_URL}/devices`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`device discovery failed: HTTP ${res.status}`);
  const devices = (await res.json()) as { id: string; profile: string | null; enabled: boolean }[];
  return devices.filter((d) => d.enabled).map((d) => ({ id: d.id, profile: d.profile }));
}

async function main(): Promise<void> {
  const devices = await retry(discoverDevices, { logger: log, label: 'device discovery', retries: 60 });
  for (let i = 0; i < env.SIM_DEVICE_COUNT; i++) devices.push({ id: `sim-env-${String(i + 1).padStart(3, '0')}`, profile: 'env' });
  log.info({ devices: devices.length }, 'simulating devices');

  const client = mqtt.connect(env.MQTT_URL, {
    clientId: `dt-simulator-${process.pid}`,
    username: env.MQTT_DEVICE_USERNAME,
    password: env.MQTT_DEVICE_PASSWORD,
    protocolVersion: 5,
    reconnectPeriod: 2_000,
  });
  await new Promise<void>((resolve, reject) => {
    client.once('connect', () => resolve());
    client.once('error', reject);
  });
  client.on('error', (err) => log.error({ err: err.message }, 'mqtt error'));

  const states = new Map<string, SimState>(devices.map((d) => [d.id, { fault: 0, faultTicks: 0, phase: Math.random() * 6.28, counter: 0 }]));
  let running = true;

  // Announce online status (retained so late subscribers see it)
  for (const d of devices) {
    client.publish(mqttTopic(env.TENANT_ID, d.id, 'status', env.MQTT_TOPIC_ROOT), JSON.stringify({ online: true }), { qos: 1, retain: true });
  }

  const loop = async () => {
    while (running) {
      const started = Date.now();
      const now = new Date();
      for (const d of devices) {
        const s = states.get(d.id)!;
        s.phase += 0.05;
        s.counter++;
        // Fault episodes: ramp up, hold, recover — produces warning → critical → resolved
        if (s.faultTicks > 0) {
          s.faultTicks--;
          s.fault = s.faultTicks > 20 ? Math.min(1, s.fault + 0.15) : Math.max(0, s.fault - 0.1);
        } else if (Math.random() < env.SIM_ANOMALY_PROBABILITY) {
          s.faultTicks = 30 + Math.floor(Math.random() * 30);
          log.info({ device: d.id, profile: d.profile }, 'injecting fault episode');
        } else {
          s.fault = 0;
        }
        const profile = profiles[d.profile ?? DEFAULT_PROFILE] ?? profiles[DEFAULT_PROFILE]!;
        client.publish(mqttTopic(env.TENANT_ID, d.id, 'telemetry', env.MQTT_TOPIC_ROOT), JSON.stringify(profile(s, now)), { qos: 1 });
      }
      // Spread publishes evenly; compensate for loop time
      await sleep(Math.max(50, env.SIM_PUBLISH_INTERVAL_MS - (Date.now() - started)));
    }
  };
  void loop();

  onShutdown(log, [
    () => new Promise<void>((resolve) => client.end(false, {}, () => resolve())),
    () => {
      running = false;
    },
  ]);
}

main().catch((err: Error) => {
  log.fatal({ err: err.message }, 'simulator crashed');
  process.exit(1);
});
