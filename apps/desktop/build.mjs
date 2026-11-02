// Bundles the Electron main process with esbuild into one CommonJS file.
// `electron` is provided by the runtime and stays external.
import { build } from 'esbuild';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');

await build({
  entryPoints: [resolve(here, 'src/main.ts')],
  outfile: resolve(root, 'dist/apps/desktop/main/main.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  sourcemap: true,
  tsconfig: resolve(here, 'tsconfig.app.json'),
  external: ['electron'],
  logLevel: 'info',
});
