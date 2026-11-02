#!/usr/bin/env node
/**
 * Stages the built server (dist/apps/server) into dist/apps/desktop/server and
 * installs its runtime dependencies there with a committed lockfile. The app
 * never ships the workspace node_modules.
 *
 * The built dist/apps/server/package.json contains the exact versions the
 * workspace was tested with (written by apps/server/build.mjs). The committed
 * apps/desktop/server-package-lock.json must describe exactly that dependency
 * set; otherwise this script fails instead of resolving versions afresh.
 *
 * Install is always `npm ci --omit=dev` against the committed lockfile. There
 * is no silent `npm install` in this path. When server dependencies change:
 *
 *   node apps/desktop/scripts/stage-server.mjs --update-lockfile
 *
 * then review and commit apps/desktop/server-package-lock.json.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const src = resolve(root, 'dist/apps/server');
const out = resolve(root, 'dist/apps/desktop/server');
const committedLock = resolve(root, 'apps/desktop/server-package-lock.json');
const updateLockfile = process.argv.includes('--update-lockfile');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const node = process.execPath;

function fail(message) {
  console.error(`stage-server: ${message}`);
  process.exit(1);
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`cannot read ${label} at ${path}: ${error.message}`);
  }
}

function loadBuiltPackage() {
  if (!existsSync(join(src, 'main.mjs'))) {
    fail('dist/apps/server/main.mjs is missing; run `nx build server` (or `npm run desktop:build`) first');
  }
  const pkgPath = join(src, 'package.json');
  if (!existsSync(pkgPath)) {
    fail('dist/apps/server/package.json is missing; run `nx build server` first');
  }
  const pkg = readJson(pkgPath, 'built server package.json');
  const deps = pkg.dependencies ?? {};
  if (Object.keys(deps).length === 0) {
    fail('dist/apps/server/package.json has no runtime dependencies; is the server build complete?');
  }
  return { pkg, deps };
}

function validateLockfile(lock, pkg) {
  if (lock.lockfileVersion !== 3) {
    fail(
      `apps/desktop/server-package-lock.json must be lockfileVersion 3 (got ${lock.lockfileVersion}); ` +
        'regenerate it with --update-lockfile using the repository Node version',
    );
  }
  const rootEntry = lock.packages?.[''];
  if (!rootEntry) fail('apps/desktop/server-package-lock.json has no root package entry');
  const lockDeps = rootEntry.dependencies ?? {};
  const builtDeps = pkg.dependencies ?? {};
  const diffs = [];
  for (const name of new Set([...Object.keys(builtDeps), ...Object.keys(lockDeps)])) {
    if (builtDeps[name] !== lockDeps[name]) {
      diffs.push(`${name}: built ${builtDeps[name] ?? '(missing)'} != lock ${lockDeps[name] ?? '(missing)'}`);
    }
  }
  for (const [name, version] of Object.entries(builtDeps)) {
    const entry = lock.packages?.[`node_modules/${name}`];
    if (!entry) diffs.push(`${name}: not present in lockfile`);
    else if (entry.version !== version) diffs.push(`${name}: lockfile installs ${entry.version}, build expects ${version}`);
  }
  if (diffs.length > 0) {
    fail(
      'apps/desktop/server-package-lock.json is stale relative to dist/apps/server/package.json:\n' +
        diffs.map((line) => `  - ${line}`).join('\n') +
        '\n\nRegenerate it deliberately, then review and commit the lockfile:\n' +
        '  node apps/desktop/scripts/stage-server.mjs --update-lockfile',
    );
  }
}

/**
 * Regenerates the committed lockfile from the built package.json. This is an
 * explicit developer action, never part of the normal/CI staging path.
 */
function regenerateLockfile(pkg) {
  if (process.env.CI && process.env.OPEN_RECORD_ALLOW_LOCKFILE_UPDATE !== '1') {
    fail('refusing --update-lockfile in CI; regenerate the lockfile locally and commit it');
  }
  const work = mkdtempSync(join(tmpdir(), 'open-record-server-lock-'));
  try {
    writeFileSync(join(work, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
    console.log('stage-server: regenerating apps/desktop/server-package-lock.json with npm install --package-lock-only');
    execFileSync(
      npm,
      ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'],
      { cwd: work, stdio: 'inherit' },
    );
    const lock = readJson(join(work, 'package-lock.json'), 'generated package-lock.json');
    validateLockfile(lock, pkg);
    writeFileSync(committedLock, `${JSON.stringify(lock, null, 2)}\n`);
    console.log(`stage-server: wrote ${committedLock}`);
    console.log('stage-server: review and commit the lockfile, then rerun without --update-lockfile');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function stage() {
  const { pkg, deps } = loadBuiltPackage();

  if (updateLockfile) {
    regenerateLockfile(pkg);
    return;
  }

  if (!existsSync(committedLock)) {
    fail(
      'apps/desktop/server-package-lock.json is missing; generate and commit it with:\n' +
        '  node apps/desktop/scripts/stage-server.mjs --update-lockfile',
    );
  }
  const lock = readJson(committedLock, 'staged server lockfile');
  validateLockfile(lock, pkg);

  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  for (const file of ['main.mjs', 'main.mjs.map', 'package.json']) {
    if (existsSync(join(src, file))) copyFileSync(join(src, file), join(out, file));
  }
  copyFileSync(committedLock, join(out, 'package-lock.json'));

  console.log(`stage-server: installing exact runtime dependencies with npm ci -> ${out}`);
  execFileSync(npm, ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: out,
    stdio: 'inherit',
    env: { ...process.env, npm_config_audit: 'false', npm_config_fund: 'false' },
  });

  // Every declared dependency must be installed at the pinned version and load
  // as ESM (like main.mjs) from the staged folder.
  for (const [dep, want] of Object.entries(deps)) {
    const installedPath = join(out, 'node_modules', dep, 'package.json');
    if (!existsSync(installedPath)) fail(`${dep} did not install from the lockfile`);
    const installed = readJson(installedPath, `${dep} package.json`).version;
    if (installed !== want) fail(`${dep}: staged ${installed}, but the server build pins ${want}`);
    execFileSync(node, ['--input-type=module', '-e', `await import(${JSON.stringify(dep)})`], {
      cwd: out,
      stdio: 'inherit',
    });
    console.log(`stage-server: ${dep}@${installed} loads`);
  }

  // qrcode is external because esbuild cannot bundle its dynamic require('fs').
  // Prove both the CommonJS require and ESM import paths work in the staged app.
  if (deps.qrcode) {
    execFileSync(
      node,
      [
        '--input-type=module',
        '-e',
        "import { createRequire } from 'node:module';" +
          "const require = createRequire(import.meta.url);" +
          "const qr = require('qrcode');" +
          "if (typeof qr.toDataURL !== 'function') throw new Error('qrcode.toDataURL is missing');" +
          "await import('qrcode');" +
          "console.log('stage-server: qrcode loads via require() and import()');",
      ],
      { cwd: out, stdio: 'inherit' },
    );
  }

  console.log(`stage-server: staged -> ${out}`);
}

stage();
