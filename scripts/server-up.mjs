#!/usr/bin/env node
// Builds the web app and the server, starts the server on this machine's LAN
// address (site + API on one origin), then prints the web app URL and the
// startup banner (URL, token, pairing QR) and exits. Run with --help for flags.
// Default is detached; pid and log live in dataDir, next to the token. The log
// holds the banner (and therefore the token), so dataDir is created 0700 and
// the log 0600. The built web app is served from dist/apps/app/browser (WEB_DIR).
//
// The LAN IP ranking mirrors pickLanUrl() in apps/server/src/services/network.ts:
// ordinary LAN first, then CGNAT (100.64/10), then container bridges (172.16/12).
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, networkInterfaces } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BANNER_MARKER = 'Open Record server is ready';
const FOLLOW_TIMEOUT_MS = 90_000;
const SETTLE_MS = 500;
const STOP_TIMEOUT_MS = 10_000;
const POLL_MS = 100;

function fail(message) {
  console.error(`server:up: ${message}`);
  process.exit(1);
}

function warn(message) {
  console.warn(`server:up: warning: ${message}`);
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const USAGE = `Usage:
  npm run server:up                  detect the LAN IP, build, start detached, print banner + URL, exit 0
  npm run server:up -- --ip 10.0.0.5 use this address instead of detecting
  npm run server:up -- --host 127.0.0.1
                                     bind this address instead (e.g. behind a tunnel)
  npm run server:up -- --follow      stay attached and stream the server's output (no detach)
  npm run server:up -- --stop        stop the detached server
  npm run server:up -- --help

Environment: PORT (default 8787), PUBLIC_URL, OPEN_RECORD_DATA_DIR, HOST.
apps/server/.env is read for these as well; the flags win.`;

function parseArgs(argv) {
  const options = { follow: false, stop: false };
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--ip' || arg === '--host') {
      const name = arg.slice(2);
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('-')) {
        fail(`pass an address after --${name}, e.g. --${name} ${name === 'ip' ? '192.168.1.20' : '127.0.0.1'}`);
      }
      options[name] = value;
      i++;
    } else if (arg?.startsWith('--ip=')) options.ip = arg.slice('--ip='.length);
    else if (arg?.startsWith('--host=')) options.host = arg.slice('--host='.length);
    else if (arg === '--follow') options.follow = true;
    else if (arg === '--stop') options.stop = true;
    else if (arg === '--help' || arg === '-h') { console.log(USAGE); process.exit(0); }
    else fail(`pass --help to see the options; unknown argument "${arg}"`);
  }
  if (options.ip !== undefined && !ipv4.test(options.ip)) {
    fail(`pass an IPv4 address such as --ip 192.168.1.20; got "${options.ip}"`);
  }
  if (options.host !== undefined && !ipv4.test(options.host)) {
    fail(`pass an IPv4 address such as --host 127.0.0.1; got "${options.host}"`);
  }
  if (options.follow && options.stop) fail('pick one of --follow or --stop; they cannot be combined');
  return options;
}

/** 0 = ordinary LAN, 1 = CGNAT (100.64/10), 2 = container bridge range rarely reachable from a phone (172.16/12). */
function rank(address) {
  const [a, b] = address.split('.').map(Number);
  if (a === 172 && b >= 16 && b <= 31) return 2;
  if (a === 100 && b >= 64 && b <= 127) return 1;
  return 0;
}

/** Ordinary LAN addresses first (ranked), skipping 192.0.2.0/24 documentation addresses. */
function lanCandidates() {
  const found = [];
  for (const infos of Object.values(networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.internal || info.family !== 'IPv4' || info.address.startsWith('192.0.2.')) continue;
      found.push(info.address);
    }
  }
  return found.sort((x, y) => rank(x) - rank(y));
}

async function detectLanIp() {
  const found = lanCandidates();
  if (found.length === 0 || rank(found[0]) === 2) {
    fail('pass a LAN address with --ip <address>; none was found on this machine');
  }
  const lan = found.filter((address) => rank(address) === 0);
  if (lan.length < 2 || !process.stdin.isTTY) return found[0];
  console.log('Several network addresses found. Pick the one on your phone\'s Wi-Fi:');
  lan.forEach((address, i) => console.log(`  ${i + 1}) ${address}`));
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`Choose [1-${lan.length}] (default 1): `)).trim();
  rl.close();
  const choice = Number(answer || 1);
  if (!Number.isInteger(choice) || choice < 1 || choice > lan.length) fail(`answer with a number from 1 to ${lan.length}; got "${answer}"`);
  return lan[choice - 1];
}

/** Fails fast on what the server cannot run without; ffmpeg only ever warns. */
function preflight() {
  // esbuild targets node24 and the generated package.json requires >=24.
  if (Number(process.versions.node.split('.')[0]) < 24) {
    fail(`switch to Node 24 with nvm ("nvm install 24 && nvm use 24"); this is Node ${process.versions.node} and Node comes from nvm in this setup`);
  }
  const ytDlp = spawnSync('yt-dlp', ['--version'], { encoding: 'utf8' });
  if (ytDlp.status !== 0 || !ytDlp.stdout?.trim()) fail('install yt-dlp ("pipx install yt-dlp") and re-run; "yt-dlp --version" did not work');
  const lookup = process.platform === 'win32' ? 'where' : 'which';
  const ytDlpPath = spawnSync(lookup, ['yt-dlp'], { encoding: 'utf8' }).stdout?.split(/\r?\n/)[0]?.trim();
  console.log(`server:up: yt-dlp ${ytDlp.stdout.trim()}${ytDlpPath ? ` (${ytDlpPath})` : ''}`);
  // The distro package is often a year or more behind what the sites expect.
  if (ytDlpPath === '/usr/bin/yt-dlp') warn('/usr/bin/yt-dlp is the distro copy and can be stale; "pipx install yt-dlp" gets a current one');
  const ffmpeg = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
  const version = ffmpeg.status === 0 ? /^ffmpeg version\s+(\S+)/m.exec(ffmpeg.stdout ?? '')?.[1] : undefined;
  if (version === undefined) warn('install ffmpeg ("sudo apt install ffmpeg"); casting needs ffmpeg 6+ and none was found');
  else if (!(Number.parseInt(version, 10) >= 6)) warn(`upgrade ffmpeg ("sudo apt install ffmpeg"); found ${version} and casting needs ffmpeg 6+`);
}

/** True when the pid really is this server, so a recycled pid is never signalled. */
function isOurServer(pid) {
  if (process.platform !== 'linux') return true;
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('dist/apps/server/main.mjs');
  } catch {
    return false;
  }
}

/** A pid from any pidfile-shaped file, or undefined. */
function readPidFile(file) {
  try {
    const pid = Number(readFileSync(file, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch { return undefined; }
}

/** The pid from the pidfile, or undefined when it is missing or unreadable. */
function readPid() {
  return readPidFile(pidFile);
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** The pid of a live server, or undefined; a stale or recycled pidfile is removed. */
function livePid() {
  const pid = readPid();
  if (pid === undefined) return undefined;
  if (!alive(pid) || !isOurServer(pid)) { rmSync(pidFile, { force: true }); return undefined; }
  return pid;
}

/** Size of the log file in bytes (the point to scan from), or 0 when absent. */
function logSize() {
  try { return statSync(logFile).size; } catch { return 0; }
}

/** Log text written after `offset` bytes, or '' when the file is missing. */
function readSince(offset) {
  let fd;
  try {
    fd = openSync(logFile, 'r');
    const size = statSync(logFile).size;
    if (size <= offset) return '';
    const buf = Buffer.alloc(size - offset);
    readSync(fd, buf, 0, buf.length, offset);
    return buf.toString();
  } catch {
    return '';
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** The banner text from a block of logs (the last one), or undefined. */
function lastBanner(text) {
  const at = text.lastIndexOf(BANNER_MARKER);
  if (at < 0) return undefined;
  return text.slice(at).split('\n').filter((line) => !line.startsWith('{"level"')).join('\n');
}

async function reachable(url) {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(3000) })).ok;
  } catch {
    return false;
  }
}

/** apps/server/.env as a Map: last assignment wins, like Node's own --env-file. */
function readEnvFile() {
  const values = new Map();
  let text = '';
  try { text = readFileSync(join(root, 'apps/server/.env'), 'utf8'); } catch { return values; }
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const raw = match[2].trim();
    const quoted = /^(['"])(.*?)\1\s*(?:#.*)?$/.exec(raw);
    values.set(match[1], (quoted ? quoted[2] : raw.replace(/\s+#.*$/, '')).trim());
  }
  return values;
}

const fileEnv = readEnvFile();

/** An exported variable wins over apps/server/.env, which wins over `fallback`. */
function configured(key, fallback = '') {
  return process.env[key]?.trim() || fileEnv.get(key)?.trim() || fallback;
}

/** The URL phones use: PUBLIC_URL from the environment or apps/server/.env, else this address. */
function resolvePublicUrl(host) {
  // An IPv6 literal needs brackets to be a valid URL host; tolerate either form.
  const bare = host.replace(/^\[|\]$/g, '');
  const authority = bare.includes(':') ? `[${bare}]` : bare;
  return (configured('PUBLIC_URL') || `http://${authority}:${port}`).replace(/\/+$/, '');
}

/** Waits for the banner in the log file, or fails after FOLLOW_TIMEOUT_MS. */
async function waitForBanner(child, offset) {
  const deadline = Date.now() + FOLLOW_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (readSince(offset).includes(BANNER_MARKER)) return;
    if (child.exitCode !== null) fail(`read ${logFile} for the error and re-run; the server exited before its banner`);
    await sleep(POLL_MS);
  }
  child.kill('SIGTERM');
  fail(`read ${logFile} and re-run; no banner after ${FOLLOW_TIMEOUT_MS / 1000}s`);
}

/** Prints the banner text, then warns when this machine cannot reach /health. */
async function finish(publicUrl, bannerText) {
  console.log(bannerText.trimEnd());
  console.log(`\nWeb app: ${publicUrl}/`);
  const healthUrl = `${publicUrl}/health`;
  if (!(await reachable(healthUrl))) {
    console.log(
      `\nCould not reach ${healthUrl} from this machine. If phones cannot connect, allow TCP port ${port}\n` +
        `through the firewall (e.g. "sudo ufw allow from 192.168.1.0/24 to any port ${port} proto tcp") and\n` +
        'check the server is on the same network.',
    );
  }
  process.exit(0);
}

/** Removes the lock only if it still holds `expected`; a rename makes the race atomic. */
function dropLock(expected) {
  if (expected === undefined) return false;
  if (readPidFile(lockFile) !== expected) return false;
  const graveyard = `${lockFile}.stale.${process.pid}`;
  try {
    renameSync(lockFile, graveyard);
  } catch {
    return false; // someone else got there first
  }
  if (readPidFile(graveyard) !== expected) {
    // We moved a lock someone created between the read and the rename: put it back.
    try { renameSync(graveyard, lockFile); } catch { rmSync(graveyard, { force: true }); }
    return false;
  }
  rmSync(graveyard, { force: true });
  return true;
}

/** Creates the start lock, so two runs cannot race past the pidfile check. Returns its release. */
function takeLock(options) {
  // Only the owner may remove the lock: a later run can legitimately hold it.
  const release = () => { dropLock(process.pid); };
  const acquire = () => writeFileSync(lockFile, String(process.pid), { flag: 'wx', mode: 0o600 });
  try {
    acquire();
  } catch {
    const holder = readPidFile(lockFile);
    if (holder !== undefined && alive(holder)) {
      fail(`already running (pid ${holder}); use --stop first, or delete ${lockFile} if that is wrong`);
    }
    // Stale lock from a killed run.
    dropLock(holder);
    try { acquire(); } catch { fail(`delete ${lockFile} by hand and re-run`); }
  }
  // Ctrl-C during the build would otherwise leave the lock behind.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => { release(); process.exit(130); });
  }
  process.on('exit', release);
  return release;
}

async function start(options) {
  preflight();
  // 0700: the log below carries the token and the pairing link.
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  try { chmodSync(dataDir, 0o700); } catch { /* not ours to tighten */ }
  const running = livePid();
  if (running !== undefined) fail(`already running (pid ${running}); use --stop first`);
  const release = takeLock();

  console.log('server:up: building the web app and the server (nx build app, nx build server)');
  for (const target of ['app', 'server']) {
    const built = spawnSync('npx', ['nx', 'build', target], {
      cwd: root,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    if (built.status !== 0) fail(`fix the build errors above and re-run; "npx nx build ${target}" failed`);
  }

  // A second run may have spawned while the builds ran.
  const late = livePid();
  if (late !== undefined) fail(`already running (pid ${late}); use --stop first`);

  // Bind order: --host, then --ip, then HOST in apps/server/.env, then the LAN
  // address. Detection only runs when the bind address is not already known.
  const chosen = options.host ?? options.ip ?? configured('HOST');
  const host = chosen || (await detectLanIp());
  // A wildcard bind is not a usable URL, so the banner needs a concrete address —
  // unless PUBLIC_URL is set, in which case it is used verbatim and detection
  // would only risk a needless prompt or failure.
  const wildcard = host === '' || host === '0.0.0.0' || host === '::';
  const urlHost = wildcard && !configured('PUBLIC_URL') ? (options.ip ?? (await detectLanIp())) : host;


  // Node's --env-file-if-exists never overrides variables already present in
  // the environment, so the explicit HOST/PUBLIC_URL/WEB_DIR below win while
  // everything else (tokens, Supabase keys) comes from apps/server/.env.
  const publicUrl = resolvePublicUrl(urlHost);
  const env = { ...process.env, HOST: host, PUBLIC_URL: publicUrl, WEB_DIR: join(root, 'dist/apps/app/browser') };
  const argv = ['--env-file-if-exists=apps/server/.env', 'dist/apps/server/main.mjs'];

  console.log(`server:up: starting on ${publicUrl}`);
  if (options.follow) {
    const child = spawn(process.execPath, argv, { cwd: root, stdio: 'inherit', env });
    child.on('error', (err) => fail(`run "node --env-file-if-exists=apps/server/.env dist/apps/server/main.mjs" yourself; spawn failed (${err.message})`));
    writeFileSync(pidFile, String(child.pid), { mode: 0o600 });
    release(); // the pidfile is the running marker from here on
    // Replace the build-phase lock handlers, which would exit before the child
    // has been stopped, with the ones that forward to it.
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.removeAllListeners(signal);
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
    child.on('exit', (code) => process.exit(code ?? 1));
    return;
  }

  const offset = logSize();
  const fd = openSync(logFile, 'a', 0o600);
  chmodSync(logFile, 0o600); // an older log may be 0644, and it holds the token
  const child = spawn(process.execPath, argv, { cwd: root, detached: true, stdio: ['ignore', fd, fd], env });
  child.on('error', (err) => fail(`run "node --env-file-if-exists=apps/server/.env dist/apps/server/main.mjs" yourself; spawn failed (${err.message})`));
  child.unref();
  closeSync(fd);
  writeFileSync(pidFile, String(child.pid), { mode: 0o600 });
  release(); // the pidfile is the running marker from here on

  await waitForBanner(child, offset);
  await sleep(SETTLE_MS); // let the rest of the banner (QR code) arrive
  const text = readSince(offset);
  await finish(publicUrl, lastBanner(text) ?? text);
}

async function stop() {
  // A lock held by a live launcher means a build/start is still in flight.
  const holder = readPidFile(lockFile);
  if (holder !== undefined && alive(holder)) {
    fail(`a server:up run is still starting (pid ${holder}); wait for it, or delete ${lockFile} if that is wrong`);
  }
  // Delete only the lock we inspected: a launcher may have taken it since.
  dropLock(holder);
  const pid = livePid();
  if (pid === undefined) {
    console.log('server:up: not running');
    return;
  }
  try { process.kill(pid, 'SIGTERM'); } catch (err) {
    if (err.code !== 'ESRCH') fail(`kill ${pid} yourself and delete ${pidFile}; SIGTERM failed (${err.message})`);
  }
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < deadline && alive(pid)) await sleep(POLL_MS);
  if (alive(pid)) {
    try { process.kill(pid, 'SIGKILL'); } catch (err) {
      if (err.code !== 'ESRCH') fail(`kill ${pid} yourself and delete ${pidFile}; SIGKILL failed (${err.message})`);
    }
    console.log(`server:up: pid ${pid} ignored SIGTERM for ${STOP_TIMEOUT_MS / 1000}s; sent SIGKILL`);
  } else {
    console.log(`server:up: stopped (pid ${pid})`);
  }
  rmSync(pidFile, { force: true });
}

const args = parseArgs(process.argv.slice(2));
const port = Number(configured('PORT')) || 8787;
// Must match defaultDataDir() in apps/server/src/config.ts.
const dataDir = configured('OPEN_RECORD_DATA_DIR') || join(homedir(), '.config', 'open-record');
const pidFile = join(dataDir, 'server.pid');
const logFile = join(dataDir, 'server.log');
const lockFile = join(dataDir, 'server.lock');

if (args.stop) await stop();
else await start(args);
