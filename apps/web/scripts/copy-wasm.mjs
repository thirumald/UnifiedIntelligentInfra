// Copies the web-ifc WASM binaries into /public so the browser BIM viewer can load them.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
// resolve the package entry, then walk up to its folder (package.json is not exported)
const src = dirname(require.resolve('web-ifc'));
const out = join(here, '..', 'public', 'wasm');
mkdirSync(out, { recursive: true });
for (const f of ['web-ifc.wasm', 'web-ifc-mt.wasm']) {
  const from = join(src, f);
  if (existsSync(from)) copyFileSync(from, join(out, f));
}
console.log(`web-ifc wasm copied to ${out}`);
