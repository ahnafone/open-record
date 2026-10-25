import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { lookupMetadata } from './lookup';
import { USER_AGENT, type FetchFn } from './providers';
import type { MetadataMatch, MetadataQuery } from './types';

const MAX_ART_BYTES = 8 * 1024 * 1024;
const ART_TIMEOUT_MS = 10_000;
const FFMPEG_TIMEOUT_MS = 60_000;

/** Only the iTunes and Deezer image CDNs are ever fetched (SSRF guard). */
const ART_HOSTS = [/^is\d+-ssl\.mzstatic\.com$/, /^(e-)?cdns?-images\.dzcdn\.net$/];

/** Containers where ffmpeg can embed a cover as an attached picture. */
const COVER_EXTS = new Set(['.m4a', '.mp4', '.m4b', '.mp3', '.flac']);

export interface ApplyOptions {
  fetch?: FetchFn;
  /** ffmpeg binary; defaults to `$FFMPEG_PATH` or `ffmpeg` on PATH. */
  ffmpegPath?: string;
}

export function isAllowedArtworkUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return (
    url.protocol === 'https:' &&
    !url.username &&
    !url.password &&
    (url.port === '' || url.port === '443') &&
    ART_HOSTS.some((re) => re.test(url.hostname))
  );
}

/** Downloads cover art (allow-listed hosts, https only, no redirects, size-capped). */
async function downloadArtwork(url: string, fetchFn: FetchFn): Promise<{ data: Buffer; ext: string }> {
  if (!isAllowedArtworkUrl(url)) throw new Error('artwork host not allowed');
  const res = await fetchFn(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(ART_TIMEOUT_MS),
    redirect: 'error',
  });
  if (!res.ok || !res.body) throw new Error(`artwork HTTP ${res.status}`);
  const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  const ext = type === 'image/jpeg' || type === 'image/jpg' ? '.jpg' : type === 'image/png' ? '.png' : '';
  if (!ext) throw new Error(`unexpected artwork type ${type || '(none)'}`);
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > MAX_ART_BYTES) throw new Error('artwork too large');

  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_ART_BYTES) {
      await reader.cancel();
      throw new Error('artwork too large');
    }
    chunks.push(value);
  }
  return { data: Buffer.concat(chunks), ext };
}

/** Strips control characters and caps length for tag values. */
function tagValue(v: string): string {
  // eslint-disable-next-line no-control-regex
  return v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 500);
}

function runFfmpeg(bin: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'], shell: false });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => {
      if (stderr.length < 4000) stderr += d.toString();
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), FFMPEG_TIMEOUT_MS);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg failed (${signal ?? code}): ${stderr.trim().slice(0, 500)}`));
    });
  });
}

/**
 * Rewrites title/artist/album/date/genre tags and, where the container
 * supports it, replaces the embedded cover with the match's artwork. Writes
 * to a temp file next to the original, then renames over it. If the artwork
 * cannot be fetched the tags are still written and any existing cover kept.
 */
export async function applyMetadata(filePath: string, match: MetadataMatch, opts: ApplyOptions = {}): Promise<void> {
  const info = await stat(filePath);
  if (!info.isFile()) throw new Error('not a file');
  const ext = extname(filePath).toLowerCase();
  const bin = opts.ffmpegPath ?? process.env['FFMPEG_PATH'] ?? 'ffmpeg';

  let workDir: string | undefined;
  let coverPath: string | undefined;
  const tmpOut = join(dirname(filePath), `.${basename(filePath, ext)}.tagging-${randomBytes(6).toString('hex')}${ext}`);

  try {
    if (match.artworkUrl && COVER_EXTS.has(ext)) {
      try {
        const art = await downloadArtwork(match.artworkUrl, opts.fetch ?? fetch);
        workDir = await mkdtemp(join(tmpdir(), 'open-record-cover-'));
        coverPath = join(workDir, `cover${art.ext}`);
        await writeFile(coverPath, art.data);
      } catch {
        coverPath = undefined; // tags still get written
      }
    }

    const args = ['-hide_banner', '-nostdin', '-v', 'error', '-y', '-i', filePath];
    if (coverPath) {
      args.push('-i', coverPath, '-map', '0:a', '-map', '1:0', '-c', 'copy', '-disposition:v:0', 'attached_pic');
      if (ext === '.mp3') {
        args.push('-id3v2_version', '3', '-metadata:s:v', 'title=Album cover', '-metadata:s:v', 'comment=Cover (front)');
      }
    } else {
      args.push('-map', '0', '-c', 'copy');
      if (ext === '.mp3') args.push('-id3v2_version', '3');
    }
    args.push('-map_metadata', '0');

    const tags: [string, string | number | undefined][] = [
      ['title', match.title],
      ['artist', match.artist],
      ['album', match.album],
      ['date', match.year],
      ['genre', match.genre],
    ];
    for (const [k, v] of tags) {
      if (v === undefined || v === '') continue;
      args.push('-metadata', `${k}=${tagValue(String(v))}`);
    }
    args.push(tmpOut);

    await runFfmpeg(bin, args);
    await rename(tmpOut, filePath);
  } finally {
    await rm(tmpOut, { force: true }).catch(() => undefined);
    if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export interface EnrichOptions extends ApplyOptions {
  log?: { warn: (obj: unknown, msg?: string) => void };
}

/**
 * Looks the track up and, on a confident match, tags the file in place.
 * Never throws: returns the applied match, or null on no match or any error
 * (the file is left as it was).
 */
export async function enrichFile(
  filePath: string,
  info: MetadataQuery,
  opts: EnrichOptions = {},
): Promise<MetadataMatch | null> {
  try {
    const match = await lookupMetadata(info, {
      fetch: opts.fetch,
      onProviderError: (source, err) => opts.log?.warn({ source, err: String(err) }, 'metadata provider failed'),
    });
    if (!match) return null;
    await applyMetadata(filePath, match, opts);
    return match;
  } catch (err) {
    opts.log?.warn({ err: String(err), file: basename(filePath) }, 'metadata enrichment failed');
    return null;
  }
}
