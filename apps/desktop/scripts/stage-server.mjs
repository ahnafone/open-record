#!/usr/bin/env node
// Stages the built server (dist/apps/server) into dist/apps/desktop/server and
// installs only its runtime npm dependencies there, so the desktop app never
// ships the workspace node_modules. Run after `nx build server`.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const src = resolve(root, 'dist/apps/server');
const out = resolve(root, 'dist/apps/desktop/server');

if (!existsSync(join(src, 'main.mjs'))) {
  console.error('stage-server: dist/apps/server/main.mjs is missing; run `nx build server` first');
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const file of ['main.mjs', 'main.mjs.map', 'package.json']) {
  if (existsSync(join(src, file))) copyFileSync(join(src, file), join(out, file));
}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
execFileSync(npm, ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
  cwd: out,
  stdio: 'inherit',
});

// Every declared dependency must load (as ESM, like main.mjs) from the staged folder.
const pkg = JSON.parse(readFileSync(join(out, 'package.json'), 'utf8'));
for (const dep of Object.keys(pkg.dependencies ?? {})) {
  const installed = JSON.parse(readFileSync(join(out, 'node_modules', dep, 'package.json'), 'utf8'));
  execFileSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(dep)})`], {
    cwd: out,
    stdio: 'inherit',
  });
  console.log(`stage-server: ${dep}@${installed.version} loads`);
}
console.log(`stage-server: staged -> ${out}`);
