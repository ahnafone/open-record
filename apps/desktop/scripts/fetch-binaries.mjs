#!/usr/bin/env node
// Downloads the pinned Linux x64 yt-dlp and ffmpeg binaries into
// dist/apps/desktop/bin (gitignored) and verifies each against the SHA-256
// list its upstream release publishes. Linux only (desktop spike).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const binDir = resolve(root, 'dist/apps/desktop/bin');

const YTDLP_VERSION = '2026.10.26';
const YTDLP_BASE = `https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}`;
// BtbN autobuild tags are dated; LGPL build (native AAC encoder is all the server needs).
const FFMPEG_TAG = 'autobuild-2026-11-01-12-49';
const FFMPEG_ASSET = 'ffmpeg-n8.1.3-29-gad3b795b72-linux64-lgpl-8.1.tar.xz';
const FFMPEG_BASE = `https://github.com/BtbN/FFmpeg-Builds/releases/download/${FFMPEG_TAG}`;

if (process.platform !== 'linux' || process.arch !== 'x64') {
  console.error('fetch-binaries: only linux x64 is supported by this spike');
  process.exit(1);
}

async function download(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** Expected hash for `name` from a `<hex>  <name>` sums file. */
function expectedHash(sums, name) {
  for (const line of sums.split('\n')) {
    const [hash, file] = line.trim().split(/\s+\*?/);
    if (file === name) return hash.toLowerCase();
  }
  throw new Error(`no checksum listed for ${name}`);
}

async function fetchVerified(base, name, sumsName) {
  const sums = (await download(`${base}/${sumsName}`)).toString('utf8');
  const data = await download(`${base}/${name}`);
  const want = expectedHash(sums, name);
  const got = sha256(data);
  if (got !== want) throw new Error(`${name}: SHA-256 mismatch (want ${want}, got ${got})`);
  console.log(`fetch-binaries: ${name} sha256 ${got} OK`);
  return data;
}

mkdirSync(binDir, { recursive: true });
const stamp = join(binDir, 'VERSIONS.json');
const wanted = { ytdlp: YTDLP_VERSION, ffmpeg: FFMPEG_ASSET };
if (existsSync(stamp) && readFileSync(stamp, 'utf8') === JSON.stringify(wanted)) {
  console.log('fetch-binaries: up to date');
  process.exit(0);
}

const ytdlp = await fetchVerified(YTDLP_BASE, 'yt-dlp_linux', 'SHA2-256SUMS');
writeFileSync(join(binDir, 'yt-dlp'), ytdlp);
chmodSync(join(binDir, 'yt-dlp'), 0o755);

const archive = await fetchVerified(FFMPEG_BASE, FFMPEG_ASSET, 'checksums.sha256');
// Extract in a fresh, empty directory; only ffmpeg is kept.
const work = mkdtempSync(join(binDir, '.ffmpeg-'));
try {
  writeFileSync(join(work, FFMPEG_ASSET), archive);
  execFileSync('tar', ['-xJf', join(work, FFMPEG_ASSET), '-C', work, '--wildcards', '*/bin/ffmpeg']);
  const top = FFMPEG_ASSET.replace(/\.tar\.xz$/, '');
  // ffprobe is not used by the server, so it is not shipped.
  for (const bin of ['ffmpeg']) {
    copyFileSync(join(work, top, 'bin', bin), join(binDir, bin));
    chmodSync(join(binDir, bin), 0o755);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

writeFileSync(stamp, JSON.stringify(wanted));
console.log(`fetch-binaries: done -> ${binDir}`);
