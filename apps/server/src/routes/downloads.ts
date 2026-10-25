import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname } from 'node:path';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { DownloadManager, downloadOptionsFromEnv, jobView } from '../services/downloads';
import { UrlRejectedError, validateUrl } from '../services/url-guard';
import type { RouteOptions } from './index';

const CONTENT_TYPES: Record<string, string> = {
  '.m4a': 'audio/mp4',
  '.mp4': 'audio/mp4',
  '.aac': 'audio/aac',
  '.mp3': 'audio/mpeg',
  '.opus': 'audio/ogg',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.webm': 'audio/webm',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
};

const urlBody = {
  type: 'object',
  required: ['url'],
  properties: { url: { type: 'string', minLength: 1, maxLength: 4096 } },
} as const;

const idParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', maxLength: 64 } },
} as const;

/** "Artist - Title.m4a" with anything unsafe for a filename removed. */
function fileName(artist: string | undefined, title: string | undefined, ext: string): string {
  const base = [artist, title].filter(Boolean).join(' - ') || 'download';
  return `${base.replace(/[\\/:*?"<>|\p{Cc}]+/gu, '_').slice(0, 150)}${ext}`;
}

function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** Parses a single `bytes=a-b` range. Returns null if absent/multi, 'invalid' if unsatisfiable. */
function parseRange(header: string | undefined, size: number): { start: number; end: number } | null | 'invalid' {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null; // unsupported (e.g. multiple ranges): serve the whole file
  const [, a, b] = m;
  let start: number;
  let end: number;
  if (a === '' && b === '') return 'invalid';
  if (a === '') {
    start = Math.max(0, size - Number(b));
    end = size - 1;
  } else {
    start = Number(a);
    end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
  }
  if (start > end || start >= size) return 'invalid';
  return { start, end };
}

function badUrl(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof UrlRejectedError) return reply.code(400).send({ error: err.message });
  throw err;
}

/** POST /downloads, GET /downloads/:id, GET /downloads/:id/file. */
export const downloadRoutes: FastifyPluginAsync<RouteOptions> = async (app, { config }) => {
  const manager = new DownloadManager(downloadOptionsFromEnv(config.dataDir));
  manager.start();
  app.addHook('onClose', async () => manager.stop());

  app.post<{ Body: { url: string } }>('/downloads', { schema: { body: urlBody } }, async (request, reply) => {
    let url: string;
    try {
      url = await validateUrl(request.body.url);
    } catch (err) {
      return badUrl(reply, err);
    }
    const job = manager.create(url);
    if (!job) return reply.code(429).send({ error: 'too many queued downloads, try again later' });
    return reply.code(202).send({ id: job.id, status: job.status });
  });

  app.get<{ Params: { id: string } }>('/downloads/:id', { schema: { params: idParams } }, async (request, reply) => {
    const job = manager.get(request.params.id);
    if (!job) return reply.code(404).send({ error: 'download not found' });
    return jobView(job);
  });

  app.get<{ Params: { id: string } }>('/downloads/:id/file', { schema: { params: idParams } }, async (request, reply) => {
    const job = manager.get(request.params.id);
    if (!job || job.status !== 'done' || !job.filePath) {
      return reply.code(404).send({ error: 'file not available' });
    }
    let size: number;
    try {
      size = (await stat(job.filePath)).size;
    } catch {
      return reply.code(404).send({ error: 'file not available' });
    }
    const ext = extname(job.filePath).toLowerCase();
    reply
      .header('Content-Type', CONTENT_TYPES[ext] ?? 'application/octet-stream')
      .header('Content-Disposition', contentDisposition(fileName(job.track?.artist, job.track?.title, ext)))
      .header('Accept-Ranges', 'bytes')
      .header('Cache-Control', 'private, no-store');

    const range = parseRange(request.headers.range, size);
    if (range === 'invalid') {
      return reply.code(416).header('Content-Range', `bytes */${size}`).send();
    }
    if (range) {
      reply
        .code(206)
        .header('Content-Range', `bytes ${range.start}-${range.end}/${size}`)
        .header('Content-Length', range.end - range.start + 1);
      return reply.send(createReadStream(job.filePath, range));
    }
    reply.header('Content-Length', size);
    return reply.send(createReadStream(job.filePath));
  });
};
