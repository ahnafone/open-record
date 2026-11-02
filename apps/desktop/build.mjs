// Bundles the Electron main process and the sandboxed preload with esbuild.
// `electron` is provided by the runtime and stays external; everything else
// (including our TypeScript modules) is inlined into two CommonJS files.
import { build } from 'esbuild';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const outdir = resolve(root, 'dist/apps/desktop/main');

await build({
  entryPoints: {
    main: resolve(here, 'src/main.ts'),
    preload: resolve(here, 'src/preload.ts'),
  },
  outdir,
  entryNames: '[name]',
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  sourcemap: true,
  treeShaking: true,
  tsconfig: resolve(here, 'tsconfig.app.json'),
  external: ['electron'],
  logLevel: 'info',
});
