import type { FastifyReply } from 'fastify';
import { ResolverBusyError } from '../services/resolve-limiter';
import { UrlRejectedError } from '../services/url-guard';
import { GuestBusyError, YtDlpError } from '../services/ytdlp';

/** Seconds a client should wait before retrying a 503 from the resolve queue. */
export const RETRY_AFTER_SEC = 5;

/** Any http(s) URL inside free text (yt-dlp messages can echo one). */
const URL_IN_TEXT = /https?:\/\/[^\s'"`<>]+/gi;

/**
 * `origin + pathname` of an http(s) URL: the query string, fragment and any
 * credentials are dropped, since they can carry tokens or signed parameters.
 * Undefined when the text is not an http(s) URL.
 */
function redactUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    return `${url.origin}${url.pathname}`;
  } catch {
    return undefined;
  }
}

/** The `url` field of a JSON request body, redacted for logging. Other fields are never read. */
function bodyUrl(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null || !('url' in body)) return undefined;
  const url = (body as { url: unknown }).url;
  return typeof url === 'string' ? redactUrl(url) : undefined;
}

/** A log-safe copy of an error message: every URL in it is redacted the same way. */
function redactMessage(message: string): string {
  return message.replace(URL_IN_TEXT, (match) => redactUrl(match) ?? '[url]');
}

/** Maps service errors to JSON responses; anything unknown is rethrown (500). */
export function sendError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof UrlRejectedError) return reply.code(400).send({ error: err.message });
  if (err instanceof ResolverBusyError) {
    return reply.code(503).header('Retry-After', String(RETRY_AFTER_SEC)).send({ error: err.message });
  }
  if (err instanceof GuestBusyError) {
    return reply
      .code(503)
      .header('Retry-After', String(RETRY_AFTER_SEC))
      .send({ error: 'guest_busy' });
  }
  if (err instanceof YtDlpError) {
    // Cloudflare replaces 5xx bodies, so the reason is only visible in the logs.
    reply.request.log.warn(
      { url: bodyUrl(reply.request.body), status: err.status, err: redactMessage(err.message) },
      'resolve failed',
    );
    return reply.code(err.status).send({ error: err.message });
  }
  throw err;
}
