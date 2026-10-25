// Bundles the server with esbuild. Workspace libs (tsconfig path aliases) are
// inlined; npm packages stay external and are listed in a generated
// package.json so the Docker image can install only what the server needs.
import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const outdir = resolve(root, 'dist/apps/server');
const rootPkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));

/** Runtime npm packages the server imports. Add new server deps here. */
// qrcode stays external: esbuild cannot bundle its Node entry (dynamic require of "fs").
const runtimeDeps = ['fastify', '@fastify/cors', '@fastify/rate-limit', 'qrcode'];

const missing = runtimeDeps.filter((d) => !rootPkg.dependencies?.[d]);
if (missing.length) {
  throw new Error(`Missing in root package.json dependencies: ${missing.join(', ')}`);
}

mkdirSync(outdir, { recursive: true });

await build({
  entryPoints: [resolve(here, 'src/main.ts')],
  outfile: resolve(outdir, 'main.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  sourcemap: true,
  tsconfig: resolve(here, 'tsconfig.app.json'),
  external: runtimeDeps.flatMap((d) => [d, `${d}/*`]),
  logLevel: 'info',
});

writeFileSync(
  resolve(outdir, 'package.json'),
  JSON.stringify(
    {
      name: 'open-record-server',
      private: true,
      type: 'module',
      main: 'main.mjs',
      engines: { node: '>=24' },
      dependencies: Object.fromEntries(
        runtimeDeps.map((d) => [d, rootPkg.dependencies[d]]),
      ),
    },
    null,
    2,
  ) + '\n',
);
