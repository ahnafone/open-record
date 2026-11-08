#!/usr/bin/env node
/**
 * Downloads and verifies the pinned yt-dlp and ffmpeg binaries used by the
 * desktop app. Output goes to dist/apps/desktop/bin (gitignored).
 *
 * Supported targets:
 *   linux x64   -> yt-dlp, ffmpeg (BtbN LGPL build)
 *   win32 x64   -> yt-dlp.exe, ffmpeg.exe (BtbN LGPL build)
 *   darwin arm64/x64 -> yt-dlp, ffmpeg (ffmpeg-static release)
 *
 * Every asset is pinned by URL (a release tag, never "latest") and by
 * SHA-256. yt-dlp checksums are additionally checked against the release's
 * SHA2-256SUMS (itself pinned), and BtbN archives against its checksums.sha256
 * (also pinned), so a tampered checksum file is detected as well.
 *
 * Mirroring: set OPEN_RECORD_BINARIES_BASE to a stable mirror/release base.
 * It must contain this flat layout:
 *
 *   <base>/SHA2-256SUMS
 *   <base>/checksums.sha256
 *   <base>/yt-dlp_linux
 *   <base>/yt-dlp.exe
 *   <base>/yt-dlp_macos
 *   <base>/ffmpeg-n8.1.3-29-gad3b795b72-linux64-lgpl-8.1.tar.xz
 *   <base>/ffmpeg-n8.1.3-29-gad3b795b72-win64-lgpl-8.1.zip
 *   <base>/ffmpeg-darwin-arm64.gz
 *   <base>/ffmpeg-darwin-x64.gz
 *
 * Mirror assets are preferred; a missing mirror asset falls back to the pinned
 * upstream release. A checksum mismatch is always fatal. This is what keeps
 * BtbN's dated release tags from being the only source for Linux/Windows
 * ffmpeg: mirror the pinned archives to a project-hosted release and set the
 * variable in CI.
 *
 * Usage:
 *   node apps/desktop/scripts/fetch-binaries.mjs
 *   node apps/desktop/scripts/fetch-binaries.mjs --platform darwin --arch x64
 *   node apps/desktop/scripts/fetch-binaries.mjs --force
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const binDir = resolve(root, 'dist/apps/desktop/bin');
const stampPath = join(binDir, 'VERSIONS.json');

const MIRROR_BASE = (process.env.OPEN_RECORD_BINARIES_BASE ?? '').trim().replace(/\/+$/, '');
const FETCH_TIMEOUT_MS = 10 * 60 * 1000;
const FETCH_ATTEMPTS = 3;

const YTDLP = {
  version: '2026.10.26',
  base: 'https://github.com/yt-dlp/yt-dlp/releases/download/2026.10.26',
  license: 'Unlicense',
  sums: {
    name: 'SHA2-256SUMS',
    sha256: '0d7ec4303a02bcbe66154d478852cdf2e07688d39dc4597316e4424ac4e74356',
  },
  assets: {
    linux: {
      x64: {
        name: 'yt-dlp_linux',
        sha256: '767ba9dce7052aa196f8b12652f433d76de128ba168966fa84b6394d5e6c6795',
      },
    },
    win32: {
      x64: {
        name: 'yt-dlp.exe',
        sha256: 'f5389d3698ecde4ef06f4e6b1ce0294fe9ac1396228c8990b8d3416d6d177a7d',
      },
    },
    darwin: {
      arm64: {
        name: 'yt-dlp_macos',
        sha256: '0f922c15ccc0b83eefa1c8bc9104e434318c4bf16e408e1ee93b7745a6efe0aa',
      },
      x64: {
        name: 'yt-dlp_macos',
        sha256: '0f922c15ccc0b83eefa1c8bc9104e434318c4bf16e408e1ee93b7745a6efe0aa',
      },
    },
  },
};

// BtbN autobuild tags are dated: mirror these archives for long-term CI
// reproducibility. These are explicit LGPL builds (no --enable-gpl).
const FFMPEG_BTBN = {
  version: 'n8.1.3',
  release: 'autobuild-2026-11-01-12-49',
  base: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-11-01-12-49',
  license: 'LGPL-2.1-or-later',
  sums: {
    name: 'checksums.sha256',
    sha256: '0b5f810fcbfe2df99282046b8ad6e604fd3bd42163aea544b2486540af660292',
  },
  assets: {
    linux: {
      x64: {
        name: 'ffmpeg-n8.1.3-29-gad3b795b72-linux64-lgpl-8.1.tar.xz',
        sha256: 'e11f11b5d6fb4139d7468c241edc99ae904ecb25888f25247f39dff3f52928ec',
        format: 'tar.xz',
      },
    },
    win32: {
      x64: {
        name: 'ffmpeg-n8.1.3-29-gad3b795b72-win64-lgpl-8.1.zip',
        sha256: 'a152a35aacfe7972dce74f1e1d2a1cfaabc8daa7bf8632e9473f70ad18c6c5d4',
        format: 'zip',
      },
    },
  },
};

// BtbN does not publish macOS builds. ffmpeg-static is a stable, versioned
// release with arm64 and x64 assets; the hashes below pin the exact .gz files.
// See THIRD_PARTY_NOTICES.md for the macOS licensing caveat.
const FFMPEG_STATIC = {
  version: '6.1.1',
  release: 'b6.1.1',
  base: 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1',
  license: 'LGPL-2.1-or-later (see THIRD_PARTY_NOTICES.md)',
  sums: null,
  assets: {
    darwin: {
      arm64: {
        name: 'ffmpeg-darwin-arm64.gz',
        sha256: '8923876afa8db5585022d7860ec7e589af192f441c56793971276d450ed3bbfa',
        format: 'gz',
      },
      x64: {
        name: 'ffmpeg-darwin-x64.gz',
        sha256: '929b375c1182d956c51f7ac25e0b2b0411fb01f6f407aa15c9758efeb4242106',
        format: 'gz',
      },
    },
  },
};

const PLATFORM_ALIASES = {
  linux: 'linux',
  win: 'win32',
  win32: 'win32',
  windows: 'win32',
  darwin: 'darwin',
  mac: 'darwin',
  macos: 'darwin',
};
const ARCH_ALIASES = { x64: 'x64', amd64: 'x64', arm64: 'arm64', aarch64: 'arm64' };

function fail(message) {
  console.error(`fetch-binaries: ${message}`);
  process.exit(1);
}

function usage() {
  console.log(`Usage: node apps/desktop/scripts/fetch-binaries.mjs [options]

Options:
  --platform <linux|win32|darwin>  Target platform (default: host)
  --arch <x64|arm64>               Target architecture (default: host)
  --force                          Re-download even when VERSIONS.json matches
  -h, --help                       Show this help

Environment:
  OPEN_RECORD_BINARIES_BASE        Stable mirror/release base (flat layout,
                                   see the header of this script). Preferred over
                                   the pinned GitHub release URLs.

Supported targets: linux/x64, win32/x64, darwin/arm64, darwin/x64.
`);
}

function parseArgs(argv) {
  const opts = {
    platform: process.env.OPEN_RECORD_TARGET_PLATFORM || process.platform,
    arch: process.env.OPEN_RECORD_TARGET_ARCH || process.arch,
    force: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) fail(`${arg} needs a value`);
      return argv[i];
    };
    if (arg === '-h' || arg === '--help') {
      usage();
      process.exit(0);
    } else if (arg === '--force') {
      opts.force = true;
    } else if (arg === '--platform') {
      opts.platform = next();
    } else if (arg.startsWith('--platform=')) {
      opts.platform = arg.slice('--platform='.length);
    } else if (arg === '--arch') {
      opts.arch = next();
    } else if (arg.startsWith('--arch=')) {
      opts.arch = arg.slice('--arch='.length);
    } else {
      fail(`unknown argument "${arg}" (try --help)`);
    }
  }
  const rawPlatform = String(opts.platform).toLowerCase();
  const rawArch = String(opts.arch).toLowerCase();
  opts.platform = PLATFORM_ALIASES[rawPlatform];
  opts.arch = ARCH_ALIASES[rawArch];
  if (!opts.platform) fail(`unsupported platform "${rawPlatform}" (supported: linux, win32, darwin)`);
  if (!opts.arch) fail(`unsupported architecture "${rawArch}" (supported: x64, arm64)`);
  return opts;
}

function targetFor(platform, arch) {
  const ytdlp = YTDLP.assets[platform]?.[arch];
  const ffmpeg = FFMPEG_BTBN.assets[platform]?.[arch] ?? FFMPEG_STATIC.assets[platform]?.[arch];
  if (!ytdlp || !ffmpeg) {
    fail(
      `no pinned binaries for ${platform}/${arch}. Supported targets: ` +
        'linux/x64, win32/x64, darwin/arm64, darwin/x64',
    );
  }
  const ffmpegSource = FFMPEG_BTBN.assets[platform]?.[arch] ? FFMPEG_BTBN : FFMPEG_STATIC;
  return { platform, arch, ytdlp, ffmpeg, ffmpegSource };
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function fetchOnce(url) {
  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { 'user-agent': 'open-record-desktop-build/1.0' },
  });
  if (!res.ok) {
    const error = new Error(`HTTP ${res.status} ${res.statusText}`);
    error.status = res.status;
    throw error;
  }
  const data = Buffer.from(await res.arrayBuffer());
  if (data.length === 0) throw new Error('empty response body');
  return data;
}

async function fetchWithRetry(url) {
  let lastError;
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt += 1) {
    try {
      return await fetchOnce(url);
    } catch (error) {
      lastError = error;
      // A 404/403 from the mirror should fall through to the next source
      // immediately; transient errors get a short backoff.
      if (error.status === 404 || error.status === 403) break;
      if (attempt < FETCH_ATTEMPTS) await sleep(attempt * 1000);
    }
  }
  throw lastError;
}

/** Fetch a file from the mirror first, then the pinned upstream release. */
async function fetchFromSources(fileName, upstreamBase) {
  const sources = [];
  if (MIRROR_BASE) sources.push({ label: `mirror ${MIRROR_BASE}`, url: `${MIRROR_BASE}/${fileName}` });
  sources.push({ label: 'upstream', url: `${upstreamBase}/${fileName}` });

  const errors = [];
  for (const source of sources) {
    try {
      const data = await fetchWithRetry(source.url);
      console.log(`fetch-binaries: ${fileName} <- ${source.label}`);
      return data;
    } catch (error) {
      errors.push(`  ${source.label}: ${error.message}\n    ${source.url}`);
      if (!MIRROR_BASE) break;
    }
  }
  throw new Error(
    `could not download ${fileName}:\n${errors.join('\n')}\n` +
      'Mirror the pinned assets and set OPEN_RECORD_BINARIES_BASE (flat layout; see --help).',
  );
}

/** `<hex>  <name>` or `<hex> *<name>` checksum file -> hex for `name`. */
function checksumFor(text, name) {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
    if (match && match[2] === name) return match[1].toLowerCase();
  }
  return null;
}

async function fetchChecksumFile(manifest, upstreamBase) {
  const data = await fetchFromSources(manifest.name, upstreamBase);
  const got = sha256(data);
  if (got !== manifest.sha256) {
    throw new Error(
      `${manifest.name}: SHA-256 mismatch (pinned ${manifest.sha256}, got ${got}). ` +
        'The checksum manifest itself is pinned; do not continue with an unexpected file.',
    );
  }
  return data.toString('utf8');
}

async function downloadVerified(asset, upstreamBase, checksumText, label) {
  const data = await fetchFromSources(asset.name, upstreamBase);
  const got = sha256(data);
  if (got !== asset.sha256) {
    throw new Error(
      `${label} ${asset.name}: SHA-256 mismatch\n  pinned: ${asset.sha256}\n  got:    ${got}\n` +
        'Refusing to ship an unverified binary.',
    );
  }
  if (checksumText) {
    const listed = checksumFor(checksumText, asset.name);
    if (!listed) throw new Error(`${label}: release checksums do not list ${asset.name}`);
    if (listed !== asset.sha256) {
      throw new Error(
        `${label}: ${asset.name} checksum in the release manifest (${listed}) does not match ` +
          `the pinned value (${asset.sha256}); update the pin deliberately.`,
      );
    }
  }
  console.log(`fetch-binaries: ${asset.name} sha256 ${got} OK`);
  return data;
}

function findBinary(dir, name) {
  const hits = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name === name) hits.push(path);
    }
  };
  walk(dir);
  if (hits.length === 0) return null;
  // Prefer the archive's bin/ directory, then the shortest path.
  return hits.find((path) => path.split(sep).includes('bin')) ?? hits.sort((a, b) => a.length - b.length)[0];
}

function run(command, args, what) {
  try {
    execFileSync(command, args, { stdio: 'inherit' });
  } catch (error) {
    throw new Error(`${what} failed (${command}): ${error.message}`, { cause: error });
  }
}

/** Extract ffmpeg from the pinned archive and return its bytes. */
function extractFfmpeg(archiveData, asset, binaryName, workDir) {
  if (asset.format === 'gz') return gunzipSync(archiveData);

  const archivePath = join(workDir, asset.name);
  const extractDir = join(workDir, 'extract');
  writeFileSync(archivePath, archiveData);
  mkdirSync(extractDir, { recursive: true });

  if (asset.format === 'tar.xz') {
    run('tar', ['-xJf', archivePath, '-C', extractDir], 'tar extraction');
  } else if (asset.format === 'zip') {
    if (process.platform === 'win32') {
      // Windows' bundled tar is bsdtar and reads zip files.
      run('tar', ['-xf', archivePath, '-C', extractDir], 'zip extraction');
    } else {
      run('unzip', ['-q', archivePath, '-d', extractDir], 'zip extraction');
    }
  } else {
    throw new Error(`unknown archive format ${asset.format}`);
  }

  const found = findBinary(extractDir, binaryName);
  if (!found) throw new Error(`${binaryName} not found inside ${asset.name}`);
  return readFileSync(found);
}

function versionsFor(target) {
  const isWindows = target.platform === 'win32';
  return {
    platform: target.platform,
    arch: target.arch,
    binaries: {
      ytdlp: isWindows ? 'yt-dlp.exe' : 'yt-dlp',
      ffmpeg: isWindows ? 'ffmpeg.exe' : 'ffmpeg',
    },
    ytdlp: {
      version: YTDLP.version,
      asset: target.ytdlp.name,
      sha256: target.ytdlp.sha256,
      license: YTDLP.license,
    },
    ffmpeg: {
      version: target.ffmpegSource.version,
      source: target.ffmpegSource === FFMPEG_BTBN ? 'BtbN/FFmpeg-Builds' : 'eugeneware/ffmpeg-static',
      release: target.ffmpegSource.release,
      asset: target.ffmpeg.name,
      sha256: target.ffmpeg.sha256,
      license: target.ffmpegSource.license,
    },
  };
}

function isCurrent(target, expected) {
  if (!existsSync(stampPath)) return false;
  try {
    if (JSON.stringify(JSON.parse(readFileSync(stampPath, 'utf8'))) !== JSON.stringify(expected)) return false;
  } catch {
    return false;
  }
  return Object.values(expected.binaries).every(
    (name) => existsSync(join(binDir, name)) && statSync(join(binDir, name)).size > 0,
  );
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const target = targetFor(opts.platform, opts.arch);
  const expected = versionsFor(target);
  const binaryNames = Object.values(expected.binaries);

  if (!opts.force && isCurrent(target, expected)) {
    console.log(`fetch-binaries: up to date (${opts.platform}/${opts.arch})`);
    return;
  }

  const staging = mkdtempSync(join(tmpdir(), 'open-record-fetch-'));
  try {
    let checksumText = null;
    if (target.ytdlp) checksumText = await fetchChecksumFile(YTDLP.sums, YTDLP.base);
    const ytdlpData = await downloadVerified(target.ytdlp, YTDLP.base, checksumText, 'yt-dlp');

    let ffmpegChecksumText = null;
    if (target.ffmpegSource.sums) {
      ffmpegChecksumText = await fetchChecksumFile(target.ffmpegSource.sums, target.ffmpegSource.base);
    }
    const ffmpegArchive = await downloadVerified(
      target.ffmpeg,
      target.ffmpegSource.base,
      ffmpegChecksumText,
      'ffmpeg',
    );
    const ffmpegData = extractFfmpeg(ffmpegArchive, target.ffmpeg, binaryNames[1], staging);

    mkdirSync(binDir, { recursive: true });
    // Drop binaries left over from a previous platform/arch, then copy the
    // freshly verified pair into place.
    for (const stale of ['yt-dlp', 'yt-dlp.exe', 'ffmpeg', 'ffmpeg.exe']) {
      if (!binaryNames.includes(stale)) rmSync(join(binDir, stale), { force: true });
    }
    writeFileSync(join(binDir, binaryNames[0]), ytdlpData);
    writeFileSync(join(binDir, binaryNames[1]), ffmpegData);
    if (target.platform !== 'win32') {
      chmodSync(join(binDir, binaryNames[0]), 0o755);
      chmodSync(join(binDir, binaryNames[1]), 0o755);
    }
    writeFileSync(stampPath, `${JSON.stringify(expected, null, 2)}\n`);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }

  console.log(`fetch-binaries: done -> ${binDir}`);
  console.log(
    `fetch-binaries: yt-dlp ${YTDLP.version}, ffmpeg ${target.ffmpegSource.version} (${target.platform}/${target.arch})`,
  );
}

main().catch((error) => fail(error.message));
