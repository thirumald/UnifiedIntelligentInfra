/**
 * Gravitee APIM provisioner (one-shot, idempotent).
 *
 * Imports the dt-platform v4 API definitions from ./apis/*.json through the
 * Management API v2, then starts and deploys them to the gateway. Existing
 * APIs (matched by name) are left untouched unless GRAVITEE_PROVISION_FORCE
 * is true, in which case they are re-imported over the top.
 *
 * Template variables ({{NAME}}) in the definitions resolve from env, so the
 * same files work for local compose, staging and production.
 */
import { createLogger, envs, loadEnv, retry } from '@dt/common';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

const env = loadEnv(
  z.object({
    GRAVITEE_MGMT_URL: envs.str('http://gravitee-management-api:8083'),
    GRAVITEE_ADMIN_USER: envs.str('admin'),
    GRAVITEE_ADMIN_PASSWORD: envs.str('admin'),
    GRAVITEE_ENV_ID: envs.str('DEFAULT'),
    GRAVITEE_PROVISION_FORCE: envs.bool(false),
    GATEWAY_REST_CONTEXT: envs.str('/dt/v1'),
    GATEWAY_WS_CONTEXT: envs.str('/dt/realtime'),
    API_UPSTREAM_URL: envs.str('http://api:4000'),
    API_GLOBAL_PREFIX: envs.str('api/v1'),
    APIS_DIR: envs.str(join(__dirname, '..', 'apis')),
  }),
);

const log = createLogger('gateway-provisioner');
const base = `${env.GRAVITEE_MGMT_URL}/management/v2/environments/${env.GRAVITEE_ENV_ID}`;
const auth = `Basic ${Buffer.from(`${env.GRAVITEE_ADMIN_USER}:${env.GRAVITEE_ADMIN_PASSWORD}`).toString('base64')}`;

async function call<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: auth, 'content-type': 'application/json', accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → HTTP ${res.status}: ${text.slice(0, 500)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

function render(raw: string): string {
  return raw.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_m, key: string) => {
    const v = (env as Record<string, unknown>)[key];
    if (v === undefined) throw new Error(`unknown template variable {{${key}}}`);
    return String(v).replace(/"/g, '\\"');
  });
}

interface ApiSummary {
  id: string;
  name: string;
  state?: string;
}

async function existingApis(): Promise<Map<string, ApiSummary>> {
  const out = new Map<string, ApiSummary>();
  for (let page = 1; page < 50; page++) {
    const res = await call<{ data?: ApiSummary[]; pagination?: { pageCount?: number } }>('GET', `/apis?page=${page}&perPage=100`);
    for (const a of res.data ?? []) out.set(a.name, a);
    if (!res.pagination?.pageCount || page >= res.pagination.pageCount) break;
  }
  return out;
}

async function main(): Promise<void> {
  // Management API takes a while on first boot (Mongo index creation)
  await retry(() => call('GET', '/apis?page=1&perPage=1'), { logger: log, label: 'gravitee management api', retries: 60, maxMs: 10_000 });

  const existing = await existingApis();
  const files = (await readdir(env.APIS_DIR)).filter((f) => f.endsWith('.json')).sort();

  for (const file of files) {
    const definition = JSON.parse(render(await readFile(join(env.APIS_DIR, file), 'utf8'))) as { api: { name: string } };
    const name = definition.api.name;
    const current = existing.get(name);

    let id: string;
    if (current && !env.GRAVITEE_PROVISION_FORCE) {
      log.info({ name, id: current.id }, 'API already provisioned — skipping import');
      id = current.id;
    } else if (current) {
      const updated = await call<{ id: string }>('PUT', `/apis/${current.id}/_import/definition`, definition);
      id = updated.id ?? current.id;
      log.info({ name, id }, 'API definition re-imported');
    } else {
      const created = await call<{ id: string }>('POST', '/apis/_import/definition', definition);
      id = created.id;
      log.info({ name, id }, 'API imported');
    }

    const state = (await call<{ state?: string }>('GET', `/apis/${id}`)).state;
    if (state !== 'STARTED') {
      await call('POST', `/apis/${id}/_start`);
      log.info({ name }, 'API started');
    }
    await call('POST', `/apis/${id}/deployments`, { deploymentLabel: `dt-provisioner ${new Date().toISOString()}` });
    log.info({ name }, 'API deployed to gateway');
  }
  log.info({ apis: files.length }, 'gateway provisioning complete');
}

main().catch((err: Error) => {
  log.fatal({ err: err.message }, 'gateway provisioning failed');
  process.exit(1);
});
