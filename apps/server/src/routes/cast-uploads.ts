import multipart, { type MultipartFile } from '@fastify/multipart';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { pipeline } from 'node:stream';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { requireAccount } from '../plugins/auth';
import { MAX_RELAY_TTL_MS, type RelayEntry } from '../services/media-relay';
import {
  InvalidUploadError,
  UPLOAD_MIME_BY_EXT,
  UploadCache,
  UploadsDisabledError,
  UploadTooLargeError,
} from '../services/upload-cache';
import type { RouteOptions } from './index';

interface ByteRange {
  start: number;
  end: number;
}

/** Upper bound for the `Range` header value this route parses. */
const RANGE_MAX_LENGTH = 200;

/** Parses a single `bytes=start-end` / `bytes=start-` / `bytes=-suffix` range. */
function parseRange(header: string | undefined, size: number): ByteRange | 'invalid' | null {
  if (!header || header.length > RANGE_MAX_LENGTH) return header ? 'invalid' : null;
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

/**
 * Wraps the multipart file stream so a truncated upload (the busboy size limit
 * was hit) fails before the cache commits anything: the hash of a partial file
 * must never become an upload id.
 */
async function* sizeGuarded(stream: MultipartFile['file']): AsyncIterable<Buffer> {
  for await (const chunk of stream) {
    if (stream.truncated) throw new UploadTooLargeError('upload exceeds the size limit');
    yield chunk as Buffer;
  }
  if (stream.truncated) throw new UploadTooLargeError('upload exceeds the size limit');
}

/** Maps a cache/multipart failure to its HTTP response, or null when unknown. */
function uploadErrorResponse(error: unknown): { status: number; error: string } | null {
  if (error instanceof UploadTooLargeError) return { status: 413, error: 'file-too-large' };
  if (error instanceof UploadsDisabledError) return { status: 503, error: 'uploads-disabled' };
  if (error instanceof InvalidUploadError) return { status: 400, error: 'bad-file' };

  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'FST_REQ_FILE_TOO_LARGE') return { status: 413, error: 'file-too-large' };
  // Other multipart parser errors mean the body was not one well-formed file.
  if (typeof code === 'string' && code.startsWith('FST_')) {
    return { status: 400, error: 'missing-file' };
  }
  return null;
}

/**
 * Public stream of an uploaded file for a relay entry (`plan.kind === 'upload'`).
 *
 * Called from the public relay route, which has already verified the signed
 * token. The cache path is derived from the entry's own user id, never from the
 * request, so one account's relay can never reach another account's files. A
 * missing file (cleared/evicted) is `410 Gone`, not a 404: the plan existed but
 * its bytes are gone.
 */
export async function serveRelayUpload(
  cache: UploadCache,
  entry: RelayEntry,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  if (entry.plan.kind !== 'upload') return reply.code(410).send({ error: 'unavailable' });

  const path = cache.pathOf(entry.userId, entry.plan.uploadId);
  if (!path) return reply.code(410).send({ error: 'unavailable' });

  let size: number;
  try {
    const info = await stat(path);
    if (!info.isFile()) return reply.code(410).send({ error: 'unavailable' });
    size = info.size;
  } catch {
    return reply.code(410).send({ error: 'unavailable' });
  }

  const extension = extname(path).slice(1).toLowerCase();
  const mimeType =
    UPLOAD_MIME_BY_EXT[extension as keyof typeof UPLOAD_MIME_BY_EXT] ?? 'application/octet-stream';

  const range = parseRange(request.headers.range, size);
  if (range === 'invalid') {
    return reply
      .code(416)
      .header('content-range', `bytes */${size}`)
      .header('accept-ranges', 'bytes')
      .send();
  }

  const headers: Record<string, string | number> = {
    'content-type': mimeType,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-disposition': 'inline',
    'accept-ranges': 'bytes',
  };
  if (range) {
    headers['content-length'] = range.end - range.start + 1;
    headers['content-range'] = `bytes ${range.start}-${range.end}/${size}`;
  } else {
    headers['content-length'] = size;
  }

  // The response body is the file, not a serialized payload: take over the
  // socket and stream it, never buffering.
  reply.hijack();
  reply.raw.writeHead(range ? 206 : 200, headers);
  const stream = createReadStream(path, range ? { start: range.start, end: range.end } : undefined);
  pipeline(stream, reply.raw, (error) => {
    if (!error) return;
    stream.destroy();
    reply.raw.destroy();
  });
  return reply;
}

/**
 * Upload endpoints (`/cast/uploads*`) plus the handler the public relay route
 * uses for `kind: 'upload'` plans.
 *
 * Uploads are account-only (`requireAccount` refuses the static token) and
 * scoped to one user directory. They answer 503 when `options.uploads` is
 * absent, which is also how `CAST_CACHE_MB=0` presents itself.
 */
export const castUploadRoutes: FastifyPluginAsync<RouteOptions> = async (app, options) => {
  const { config } = options;
  const uploads = options.uploads instanceof UploadCache ? options.uploads : undefined;
  const maxUploadBytes = config.castUploadMaxMb * 1024 * 1024;

  await app.register(multipart, {
    limits: { fileSize: maxUploadBytes, files: 1, fields: 1 },
  });

  const disabled = async (_request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> =>
    reply.code(503).send({ error: 'uploads-disabled' });

  if (!uploads) {
    app.post('/cast/uploads', { preHandler: requireAccount }, disabled);
    app.get('/cast/uploads/usage', { preHandler: requireAccount }, disabled);
    app.delete('/cast/uploads', { preHandler: requireAccount }, disabled);
    return;
  }

  app.post('/cast/uploads', { preHandler: requireAccount }, async (request, reply) => {
    const userId = request.userId;
    if (!userId) return reply.code(403).send({ error: 'account-required' });

    let part: MultipartFile | undefined;
    try {
      part = await request.file();
    } catch {
      return reply.code(400).send({ error: 'missing-file' });
    }
    if (!part || part.fieldname !== 'file') {
      part?.file.resume();
      return reply.code(400).send({ error: 'missing-file' });
    }

    const ext = extname(basename(part.filename ?? '')).slice(1).toLowerCase();
    try {
      const stored = await uploads.store(userId, sizeGuarded(part.file), ext);
      // Enforce the per-user cap only after the new file is in place.
      await uploads.evict(userId);
      return reply.code(200).send({
        uploadId: stored.uploadId,
        sizeBytes: stored.sizeBytes,
        // A relay token can never outlive 24 h (MediaRelay's hard cap), so an
        // upload older than that cannot be referenced by any live entry anyway.
        expiresAt: Date.now() + MAX_RELAY_TTL_MS,
      });
    } catch (error) {
      const mapped = uploadErrorResponse(error);
      if (mapped) return reply.code(mapped.status).send({ error: mapped.error });
      request.log.error({ err: error }, 'cast upload failed');
      return reply.code(500).send({ error: 'upload-failed' });
    }
  });

  app.get('/cast/uploads/usage', { preHandler: requireAccount }, async (request, reply) => {
    const userId = request.userId;
    if (!userId) return reply.code(403).send({ error: 'account-required' });
    return reply.send(await uploads.usage(userId));
  });

  app.delete('/cast/uploads', { preHandler: requireAccount }, async (request, reply) => {
    const userId = request.userId;
    if (!userId) return reply.code(403).send({ error: 'account-required' });
    return reply.send(await uploads.clear(userId));
  });
};
