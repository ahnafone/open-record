import type { FastifyReply } from 'fastify';
import { ResolverBusyError } from '../services/resolve-limiter';
import { UrlRejectedError } from '../services/url-guard';
import { YtDlpError } from '../services/ytdlp';

/** Seconds a client should wait before retrying a 503 from the resolve queue. */
export const RETRY_AFTER_SEC = 5;

/** Maps service errors to JSON responses; anything unknown is rethrown (500). */
export function sendError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof UrlRejectedError) return reply.code(400).send({ error: err.message });
  if (err instanceof ResolverBusyError) {
    return reply.code(503).header('Retry-After', String(RETRY_AFTER_SEC)).send({ error: err.message });
  }
  if (err instanceof YtDlpError) return reply.code(err.status).send({ error: err.message });
  throw err;
}
