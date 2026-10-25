#!/usr/bin/env node
// Starts the download server in Docker on this machine's LAN address, then
// prints the startup banner (URL, token, pairing QR) and exits.
//
//   npm run server:up                  detect the LAN IP automatically
//   npm run server:up -- --ip 10.0.0.5 use this address instead
//
// The LAN IP ranking mirrors pickLanUrl() in apps/server/src/services/network.ts:
// ordinary LAN first, then CGNAT (100.64/10), then the Docker bridge (172.16/12).
import { spawn, spawnSync } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const composeFile = 'apps/server/docker-compose.yml';
const BANNER_MARKER = 'Open Record server is ready';
const FOLLOW_TIMEOUT_MS = 90_000;
const SETTLE_MS = 500;

function fail(message) {
  console.error(`server:up: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  let ip;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--ip') {
      ip = argv[++i];
    } else if (arg?.startsWith('--ip=')) {
      ip = arg.slice('--ip='.length);
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: npm run server:up [-- --ip <lan-address>]');
      process.exit(0);
    } else {
      fail(`unknown argument "${arg}"`);
    }
  }
  if (ip !== undefined && !/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(ip)) {
    fail(`--ip must be an IPv4 address, got "${ip}"`);
  }
  return ip;
}

/** 0 = ordinary LAN, 1 = CGNAT (100.64/10), 2 = Docker bridge (172.16/12). */
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
    fail('could not find a LAN address on this machine; pass one with --ip <address>');
  }
  const lan = found.filter((address) => rank(address) === 0);
  if (lan.length < 2 || !process.stdin.isTTY) return found[0];
  console.log('Several network addresses found. Pick the one on your phone\'s Wi-Fi:');
  lan.forEach((address, i) => console.log(`  ${i + 1}) ${address}`));
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`Choose [1-${lan.length}] (default 1): `)).trim();
  rl.close();
  const choice = Number(answer || 1);
  if (!Number.isInteger(choice) || choice < 1 || choice > lan.length) fail(`invalid choice "${answer}"`);
  return lan[choice - 1];
}

function compose(args, options = {}) {
  return spawnSync('docker', ['compose', '-f', composeFile, ...args], {
    cwd: root,
    ...options,
  });
}

async function reachable(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

const ip = parseArgs(process.argv.slice(2)) ?? (await detectLanIp());
const port = Number(process.env['PORT']) || 8787;
const publicUrl = `http://${ip}:${port}`;

if (spawnSync('docker', ['compose', 'version'], { stdio: 'ignore' }).status !== 0) {
  fail('Docker with the compose plugin is required (docker compose version failed)');
}

console.log(`server:up: starting on ${publicUrl}`);
const since = new Date(Date.now() - 1000).toISOString();
const up = compose(['up', '-d', '--build'], {
  stdio: 'inherit',
  env: { ...process.env, BIND_ADDRESS: ip, PUBLIC_URL: publicUrl },
});
if (up.status !== 0) fail('docker compose up failed');

/** Prints the banner text, then warns when this machine cannot reach /health. */
async function finish(bannerText) {
  console.log(bannerText.trimEnd());
  const healthUrl = `${publicUrl}/health`;
  if (!(await reachable(healthUrl))) {
    console.log(
      `\nCould not reach ${healthUrl} from this machine. If phones cannot connect, allow TCP port ${port}\n` +
        `through the firewall (e.g. "sudo ufw allow ${port}/tcp") and check the server is on the same network.`,
    );
  }
  process.exit(0);
}

/** The banner text from a block of logs (the last one), or undefined. */
function lastBanner(text) {
  const at = text.lastIndexOf(BANNER_MARKER);
  if (at < 0) return undefined;
  return text
    .slice(at)
    .split('\n')
    .filter((line) => !line.startsWith('{"level"'))
    .join('\n');
}

// A container that was already running with the same settings keeps its old
// banner; reuse it from the log history instead of waiting for a new one.
const containerId = compose(['ps', '-q', 'server'], { encoding: 'utf8' }).stdout.trim();
const startedAt = containerId
  ? spawnSync('docker', ['inspect', '-f', '{{.State.StartedAt}}', containerId], { encoding: 'utf8' }).stdout.trim()
  : '';
if (startedAt && Date.parse(startedAt) < Date.parse(since)) {
  const history = lastBanner(compose(['logs', '--no-color', '--no-log-prefix', 'server'], { encoding: 'utf8' }).stdout ?? '');
  if (history) await finish(history);
}

// Otherwise follow the logs until the new banner appears, then print it.
const logs = spawn(
  'docker',
  ['compose', '-f', composeFile, 'logs', '-f', '--no-color', '--no-log-prefix', '--since', since, 'server'],
  { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
);
let output = '';
let bannerSeen = false;
const timer = setTimeout(() => {
  logs.kill();
  fail(`no banner after ${FOLLOW_TIMEOUT_MS / 1000}s; check "docker compose -f ${composeFile} logs server"`);
}, FOLLOW_TIMEOUT_MS);
logs.stdout.on('data', (chunk) => {
  output += chunk.toString();
  if (bannerSeen || !output.includes(BANNER_MARKER)) return;
  bannerSeen = true;
  clearTimeout(timer);
  // Let the rest of the banner (QR code) arrive, then print and stop following.
  setTimeout(() => {
    logs.kill();
    void finish(lastBanner(output) ?? output);
  }, SETTLE_MS);
});
logs.stderr.on('data', (chunk) => process.stderr.write(chunk));
