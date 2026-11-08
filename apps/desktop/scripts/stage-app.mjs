#!/usr/bin/env node
/**
 * Validates the bundled Electron main/preload output and stages a minimal app
 * directory for electron-builder:
 *
 *   dist/apps/desktop/main/{main.cjs,preload.cjs}
 *     -> dist/apps/desktop/app/{main.cjs,preload.cjs,package.json}
 *
 * electron-builder's directories.app points at dist/apps/desktop/app and its
 * `files` list only contains these staged files. The bundled server, web app
 * and media binaries are shipped through extraResources instead.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const src = resolve(root, 'dist/apps/desktop/main');
const out = resolve(root, 'dist/apps/desktop/app');
const REQUIRED = ['main.cjs', 'preload.cjs'];

function fail(message) {
  console.error(`stage-app: ${message}`);
  process.exit(1);
}

const missing = [];
for (const file of REQUIRED) {
  const path = join(src, file);
  if (!existsSync(path)) missing.push(file);
  else if (statSync(path).size === 0) fail(`${path} exists but is empty; rebuild the desktop app`);
}

if (missing.length > 0) {
  fail(
    `missing Electron entrypoint(s) in ${src}: ${missing.join(', ')}\n` +
      'Run the desktop main/preload build first, e.g.:\n' +
      '  nx build desktop\n' +
      '  (or: npm run desktop:build)',
  );
}

// The generated package.json is the packaged app's metadata. Keep it minimal
// and dependency-free: everything else lives in extraResources.
const pkg = {
  name: 'open-record-desktop',
  version: '0.0.1',
  main: 'main.cjs',
};

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const file of REQUIRED) copyFileSync(join(src, file), join(out, file));
writeFileSync(join(out, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);

// Validate the staged result rather than trusting the copy.
for (const file of [...REQUIRED, 'package.json']) {
  const path = join(out, file);
  if (!existsSync(path) || statSync(path).size === 0) fail(`staging failed: ${path} is missing or empty`);
}
const stagedPkg = JSON.parse(readFileSync(join(out, 'package.json'), 'utf8'));
if (stagedPkg.main !== 'main.cjs' || stagedPkg.version !== '0.0.1') {
  fail('staged package.json has unexpected main/version fields');
}
if (stagedPkg.dependencies || stagedPkg.devDependencies) {
  fail('staged package.json must not declare dependencies');
}

console.log(`stage-app: staged ${REQUIRED.join(', ')}, package.json -> ${out}`);
