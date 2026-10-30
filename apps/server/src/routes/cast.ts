import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { basename, extname, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { MediaRelay, RelayEntry } from '../services/media-relay';
import { catalogAudioPath } from '../services/media-plan';
import { createResolveCache, type ResolveCache } from '../services/stream-cache';
import {
  createTranscoder,
  ffmpegAvailable,
  isCastFriendlyAudio,
  TranscodeUnavailableError,
  type FfmpegProbe,
  type TranscodeFactory,
  type Transcoder,
} from '../services/transcode';
import { resolveStream, type StreamResponse } from '../services/ytdlp';
import { validateUrl, type ValidatedUrl } from '../services/url-guard';
import { serveRelayUpload } from './cast-uploads';
import type { RouteOptions } from './index';

/** Longest relay token accepted (well above the 43 + 1 + 43 characters a real one uses). */
const TOKEN_MAX_LENGTH = 512;

/** Longest offset a cast URL may ask the transcode to start from (24 hours). */
const MAX_OFFSET_SEC = 86_400;

/**
 * Headers for a transcoded stream: ADTS AAC, chunked (the duration is unknown
 * up front) and explicitly not seekable, so a player does not retry ranges.
 */
const TRANSCODE_HEADERS: Record<string, string> = {
  'content-type': 'audio/aac',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'content-disposition': 'inline',
  'accept-ranges': 'none',
};

/** A public route is limited by IP: 300 requests per minute, like the rest of `/cast`. */
const RELAY_RATE_LIMIT_MAX = 300;

/** Token guesses from one IP per minute, checked in the handler (validity is unknown earlier). */
const INVALID_TOKEN_MAX = 30;
const INVALID_TOKEN_WINDOW_MS = 60_000;

/** Redirects followed for a resolved media URL; every hop is re-validated. */
const MAX_REDIRECTS = 3;

/**
 * At most one ffmpeg per relay entry (T6.1's "one ffmpeg per active cast
 * stream"). The receiver gets exactly one signed URL per stream, so a second
 * GET on the same entry means a retry after a blip; it supersedes the stale
 * attempt (kill its encoder, drop its source) rather than being rejected,
 * because a 409/503 would leave the speaker silent.
 */
const activeTranscodes = new Map<string, () => void>();

/** Connect/socket timeout for the upstream fetch. */
const UPSTREAM_TIMEOUT_MS = 20_000;

/** Catalog audio types served by the relay, keyed by lower-case extension. */
const CATALOG_MIME_BY_EXT: Record<string, string> = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  flac: 'audio/flac',
  wav: 'audio/wav',
};

interface ByteRange {
  start: number;
  end: number;
}

interface ResolvedMedia {
  url: string;
  mimeType?: string;
  headers?: Record<string, string>;
  expiresAt?: number;
}

/** Injected seams for the ffmpeg fallback (`RouteOptions` overrides in tests). */
interface TranscodeDeps {
  transcode: TranscodeFactory;
  hasFfmpeg: FfmpegProbe;
  ffmpegPath: string;
}

/**
 * Per-IP fixed-window counter for invalid relay tokens. Only reached after
 * `relay.verify` rejected a token, so a valid streaming request never consumes
 * the budget. Returns false once this IP has guessed 30 times in a minute.
 */
function createInvalidTokenLimiter(
  max = INVALID_TOKEN_MAX,
  windowMs = INVALID_TOKEN_WINDOW_MS,
  now: () => number = Date.now,
): (ip: string) => boolean {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  return (ip) => {
    const at = now();
    const bucket = buckets.get(ip);
    if (!bucket || bucket.resetAt <= at) {
      buckets.set(ip, { count: 1, resetAt: at + windowMs });
      return true;
    }
    if (bucket.count >= max) return false;
    bucket.count += 1;
    return true;
  };
}

/** True when `path` is inside `root` (both already resolved). */
function isInside(root: string, path: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

/** Parses a single `bytes=start-end` / `bytes=start-` / `bytes=-suffix` range. */
function parseRange(header: string | undefined, size: number): ByteRange | 'invalid' | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return 'invalid';
  const [, startRaw, endRaw] = match;

  let start: number;
  let end: number;
  if (!startRaw) {
    // Suffix range: the last N bytes.
    const suffix = Number(endRaw);
    if (!Number.isSafeInteger(suffix) || suffix <= 0 || size === 0) return 'invalid';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(startRaw);
    end = endRaw ? Number(endRaw) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return 'invalid';
  }
  if (start < 0 || start >= size || end < start) return 'invalid';
  return { start, end: Math.min(end, size - 1) };
}

/** `<webDir>/catalog/audio/<file>` for a safe catalog basename, else null. */
function safeCatalogPath(webDir: string | null, file: string): string | null {
  if (!webDir) return null;
  if (file !== basename(file)) return null;
  const extension = extname(file).slice(1).toLowerCase();
  if (!CATALOG_MIME_BY_EXT[extension]) return null;
  const root = resolve(webDir, 'catalog', 'audio');
  const path = catalogAudioPath(webDir, file);
  return isInside(root, path) ? path : null;
}

/** Streams a catalog file with single-range support; nothing is buffered. */
async function serveCatalog(
  webDir: string | null,
  file: string,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const path = safeCatalogPath(webDir, file);
  if (!path) return reply.code(404).send({ error: 'not-found' });

  let size: number;
  try {
    const info = await stat(path);
    if (!info.isFile()) return reply.code(404).send({ error: 'not-found' });
    size = info.size;
  } catch {
    return reply.code(404).send({ error: 'not-found' });
  }

  const mimeType = CATALOG_MIME_BY_EXT[extname(file).slice(1).toLowerCase()] ?? 'application/octet-stream';
  const range = parseRange(request.headers.range, size);
  if (range === 'invalid') {
    return reply
      .code(416)
      .header('content-range', `bytes */${size}`)
      .header('accept-ranges', 'bytes')
      .send();
  }

  reply
    .header('content-type', mimeType)
    .header('accept-ranges', 'bytes')
    .header('cache-control', 'no-store')
    .header('x-content-type-options', 'nosniff')
    .header('content-disposition', 'inline');

  if (range) {
    const length = range.end - range.start + 1;
    return reply
      .code(206)
      .header('content-length', String(length))
      .header('content-range', `bytes ${range.start}-${range.end}/${size}`)
      .send(createReadStream(path, { start: range.start, end: range.end }));
  }

  return reply
    .header('content-length', String(size))
    .send(createReadStream(path));
}

/** A `lookup` that can only ever hand out the addresses the URL guard vetted. */
function pinnedLookup(addresses: string[]) {
  return (
    hostname: string,
    options: { all?: boolean; family?: number | 'IPv4' | 'IPv6' },
    callback: (
      error: NodeJS.ErrnoException | null,
      address: string | Array<{ address: string; family: number }>,
      family?: number,
    ) => void,
  ): void => {
    const family = options.family;
    const wanted =
      family === 4 || family === 'IPv4' ? 4 : family === 6 || family === 'IPv6' ? 6 : undefined;
    const allowed = wanted ? addresses.filter((address) => isIP(address) === wanted) : addresses;
    const address = allowed[0];
    if (!address) {
      const error: NodeJS.ErrnoException = new Error(`no vetted address for ${hostname}`);
      error.code = 'ENOTFOUND';
      callback(error, '');
      return;
    }
    const resolvedFamily = isIP(address);
    if (options.all) callback(null, [{ address, family: resolvedFamily }]);
    else callback(null, address, resolvedFamily);
  };
}

/** One HTTP(S) GET, connected only to the vetted addresses and timed out after 20 s. */
function requestUpstream(
  target: ValidatedUrl,
  headers: Record<string, string> | undefined,
  range: string | undefined,
): Promise<http.IncomingMessage> {
  return new Promise((resolvePromise, rejectPromise) => {
    const url = new URL(target.url);
    const sendHeaders: Record<string, string> = { ...(headers ?? {}) };
    if (range) sendHeaders['range'] = range;

    const request = (url.protocol === 'https:' ? https : http).request(
      {
        protocol: url.protocol,
        // Keep the DNS name for the Host header and TLS SNI; `lookup` pins the IP.
        hostname: url.hostname.replace(/^\[|\]$/g, ''),
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers: sendHeaders,
        lookup: pinnedLookup(target.addresses),
        agent: false,
      },
      resolvePromise,
    );
    request.once('error', rejectPromise);
    request.setTimeout(UPSTREAM_TIMEOUT_MS, () => {
      request.destroy(new Error('relay upstream timed out'));
    });
    request.end();
  });
}

/**
 * GETs a resolved media URL, following at most three redirects manually. Each
 * hop goes through the URL guard before it is fetched, so a redirect cannot
 * move the relay onto a private or metadata address.
 */
async function fetchUpstream(
  initial: ValidatedUrl,
  headers: Record<string, string> | undefined,
  range: string | undefined,
  validate: (url: string) => Promise<ValidatedUrl>,
): Promise<http.IncomingMessage> {
  let target = initial;
  for (let redirects = 0; ; redirects += 1) {
    const response = await requestUpstream(target, headers, range);
    const status = response.statusCode ?? 0;
    const location = response.headers.location;
    if (status < 300 || status >= 400 || !location) return response;

    response.resume();
    if (redirects >= MAX_REDIRECTS) {
      response.destroy();
      throw new Error('too many redirects');
    }

    let next: string;
    try {
      next = new URL(location, target.url).toString();
    } catch {
      response.destroy();
      throw new Error('invalid redirect');
    }
    target = await validate(next);
  }
}

/** Relay headers for a proxied 200/206: source headers plus the no-cache hardening. */
function upstreamHeaders(upstream: http.IncomingMessage, resolved: ResolvedMedia): Record<string, string> {
  const headers: Record<string, string> = {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-disposition': 'inline',
    'content-type':
      resolved.mimeType ?? headerValue(upstream.headers['content-type']) ?? 'application/octet-stream',
  };
  for (const name of ['content-length', 'content-range', 'accept-ranges']) {
    const value = headerValue(upstream.headers[name]);
    if (value !== undefined) headers[name] = value;
  }
  return headers;
}

/** Logs only the non-secret identifiers; the request logger is silent for this route. */
function fail(
  request: FastifyRequest,
  reply: FastifyReply,
  entry: RelayEntry,
  status: number,
  error: string,
): FastifyReply {
  request.log.info({ trackId: entry.trackId, status }, 'cast relay failed');
  return reply.code(status).send({ error });
}

/** Resolves a remote entry once, reusing a still-valid `entry.resolved`. */
async function resolvedMedia(
  entry: RelayEntry,
  pageUrl: string,
  relay: MediaRelay,
  cache: ResolveCache<StreamResponse>,
): Promise<ResolvedMedia> {
  const cached = entry.resolved;
  if (cached && (cached.expiresAt === undefined || cached.expiresAt > Date.now())) {
    return cached;
  }

  const response = await cache.get(pageUrl);
  const parsedExpiry = response.expiresAt ? Date.parse(response.expiresAt) : NaN;
  const expiresAt = Number.isFinite(parsedExpiry) ? parsedExpiry : undefined;
  const resolved: ResolvedMedia = { url: response.url };
  if (response.mimeType) resolved.mimeType = response.mimeType;
  if (response.httpHeaders) resolved.headers = response.httpHeaders;
  if (expiresAt !== undefined) resolved.expiresAt = expiresAt;
  relay.setResolved(entry.id, resolved);
  return resolved;
}

/**
 * Proxies a resolved media URL. Cast-friendly sources are passed through with
 * Range support; everything else (or a `?offset` restart) is transcoded to ADTS
 * AAC by ffmpeg, with the source bytes piped in from the pinned fetch above.
 */
async function serveRemote(
  entry: RelayEntry,
  pageUrl: string,
  relay: MediaRelay,
  cache: ResolveCache<StreamResponse>,
  request: FastifyRequest,
  reply: FastifyReply,
  validate: (url: string) => Promise<ValidatedUrl>,
  offsetSec: number,
  ffmpeg: TranscodeDeps,
): Promise<FastifyReply> {
  let resolved: ResolvedMedia;
  try {
    resolved = await resolvedMedia(entry, pageUrl, relay, cache);
  } catch {
    return fail(request, reply, entry, 502, 'unavailable');
  }

  // Validate what is actually fetched, not just the page URL (`planFor` did that).
  let target: ValidatedUrl;
  try {
    target = await validate(resolved.url);
  } catch {
    return fail(request, reply, entry, 502, 'unavailable');
  }

  let upstream: http.IncomingMessage;
  try {
    upstream = await fetchUpstream(target, resolved.headers, request.headers.range, validate);
  } catch {
    return fail(request, reply, entry, 502, 'unavailable');
  }

  const status = upstream.statusCode ?? 0;
  if (status !== 200 && status !== 206) {
    upstream.resume();
    return fail(request, reply, entry, 502, 'unavailable');
  }
  // The ffmpeg probe below can await; an upstream reset in that window must not
  // become an uncaught 'error' event on the response stream.
  upstream.once('error', () => undefined);

  const mime = resolved.mimeType ?? headerValue(upstream.headers['content-type']) ?? '';
  if (isCastFriendlyAudio(mime) && offsetSec === 0) {
    reply.hijack();
    reply.raw.writeHead(status, upstreamHeaders(upstream, resolved));
    relay.setStream(entry.id, { transcoded: false, offsetSec: 0 });
    reply.raw.once('close', () => upstream.destroy());
    pipeline(upstream, reply.raw, (error) => {
      if (!error) return;
      upstream.destroy();
      reply.raw.destroy();
    });
    return reply;
  }

  // `offsetSec > 0` forces the transcode path even for a friendly mime: the
  // offset is measured in seconds into the SOURCE, and only ffmpeg's input seek
  // can honour it without the receiver having to decode from zero. The cast
  // client only sends an offset for streams it has already seen transcoded.
  if (!(await ffmpeg.hasFfmpeg(ffmpeg.ffmpegPath))) {
    upstream.resume();
    return fail(request, reply, entry, 503, 'ffmpeg-missing');
  }

  if (status === 206) {
    // A player may send Range even for a URL it expects to be transcoded. A 206
    // body is a SLICE of the source, which ffmpeg cannot decode; refetch the
    // whole object (this second request deliberately carries no Range header).
    upstream.destroy();
    try {
      upstream = await fetchUpstream(target, resolved.headers, undefined, validate);
    } catch {
      return fail(request, reply, entry, 502, 'unavailable');
    }
    if ((upstream.statusCode ?? 0) !== 200) {
      upstream.resume();
      return fail(request, reply, entry, 502, 'unavailable');
    }
  }

  // Supersede the previous attempt for this entry before starting a new encoder
  // (the previous callable kills its ffmpeg and destroys its upstream).
  activeTranscodes.get(entry.id)?.();

  let transcoder: Transcoder;
  try {
    transcoder = ffmpeg.transcode({ ffmpegPath: ffmpeg.ffmpegPath, offsetSec });
  } catch (error) {
    upstream.resume();
    if (error instanceof TranscodeUnavailableError) {
      return fail(request, reply, entry, 503, 'ffmpeg-missing');
    }
    throw error;
  }

  /** Kill this stream and drop its source; idempotent on every teardown path. */
  const teardown = (): void => {
    transcoder.kill();
    upstream.destroy();
  };
  /** Unregister only if this request still owns the entry (a newer stream may have replaced it). */
  const unregister = (): void => {
    if (activeTranscodes.get(entry.id) === teardown) activeTranscodes.delete(entry.id);
  };
  const finish = (): void => {
    unregister();
    teardown();
  };
  activeTranscodes.set(entry.id, teardown);

  // Past this point the response head is committed: a stream error destroys the
  // client socket instead of trying to write a JSON error into the audio body.
  relay.setStream(entry.id, { transcoded: true, offsetSec });
  upstream.pipe(transcoder.stdin);
  upstream.once('error', finish);
  reply.hijack();
  reply.raw.writeHead(200, TRANSCODE_HEADERS);
  reply.raw.once('close', finish);
  pipeline(transcoder.stream, reply.raw, (error) => {
    if (!error) {
      // A completed stream must not leave a stale registration behind; its own
      // close handler still runs the (idempotent) kill afterwards.
      unregister();
      return;
    }
    finish();
    reply.raw.destroy();
  });
  // ffmpeg failing after the headers went out can only be surfaced by closing
  // the socket; the receiver then reports idle and the session advances.
  void transcoder.done.catch(() => {
    finish();
    if (!reply.raw.destroyed) reply.raw.destroy();
  });
  return reply;
}

/**
 * Public cast media relay (`GET /cast/relay/:token`). The signed token is the
 * only credential: it names an in-memory plan (catalog file, remote page or,
 * from Phase 6, an upload) for exactly one track. Tokens are never logged.
 */
export const castRoutes: FastifyPluginAsync<RouteOptions> = async (app, options) => {
  const { config, relay } = options;

  if (!relay) {
    app.get('/cast/*', { config: { public: true } }, async (_request, reply) =>
      reply.code(503).send({ error: 'cast-disabled' }),
    );
    return;
  }

  const invalidToken = createInvalidTokenLimiter();
  const resolveCache = createResolveCache<StreamResponse>({
    ttlMs: config.streamCacheTtl * 1000,
    resolve: options.resolveStream ?? resolveStream,
  });
  const validateRelay = options.validateRelayUrl ?? validateUrl;
  const ffmpeg: TranscodeDeps = {
    transcode: options.transcode ?? createTranscoder,
    hasFfmpeg: options.hasFfmpeg ?? ffmpegAvailable,
    ffmpegPath: config.ffmpegPath,
  };

  app.get<{ Params: { token: string }; Querystring: { offset?: number } }>(
    '/cast/relay/:token',
    {
      config: {
        public: true,
        rateLimit: {
          max: RELAY_RATE_LIMIT_MAX,
          timeWindow: '1 minute',
          keyGenerator: (request: FastifyRequest) => request.ip,
        },
      },
      logLevel: 'silent',
      schema: {
        params: {
          type: 'object',
          required: ['token'],
          properties: { token: { type: 'string', minLength: 1, maxLength: TOKEN_MAX_LENGTH } },
        },
        querystring: {
          type: 'object',
          properties: {
            // Seconds into the source; only the transcode branch can honour it.
            offset: { type: 'number', minimum: 0, maximum: MAX_OFFSET_SEC },
          },
        },
      },
    },
    async (request, reply) => {
      const entry = relay.verify(request.params.token);
      if (!entry) {
        // Never echo the token: an invalid guess gets the same 404 as an expired one.
        if (!invalidToken(request.ip)) {
          return reply.code(429).send({ error: 'too-many-requests' });
        }
        return reply.code(404).send({ error: 'not-found' });
      }
      relay.touch(entry.id);

      switch (entry.plan.kind) {
        case 'unavailable':
          return reply.code(410).send({ error: 'unavailable' });
        case 'upload':
          // Account uploads are served from the per-user cache; a missing file
          // (cleared/evicted) is the handler's 410, not a disabled cast.
          return options.uploads
            ? serveRelayUpload(options.uploads, entry, request, reply)
            : reply.code(503).send({ error: 'cast-disabled' });
        case 'catalog':
          return serveCatalog(config.webDir, entry.plan.file, request, reply);
        case 'remote': {
          const offset = request.query.offset ?? 0;
          return serveRemote(
            entry,
            entry.plan.pageUrl,
            relay,
            resolveCache,
            request,
            reply,
            validateRelay,
            offset,
            ffmpeg,
          );
        }
      }
    },
  );
};
