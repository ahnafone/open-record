import type { FastifyPluginAsync } from 'fastify';
import { createResolveCache, tokenKey } from '../services/stream-cache';
import { resolveStream, type StreamResponse } from '../services/ytdlp';
import { validateUrl } from '../services/url-guard';
import type { RouteOptions } from './index';
import { sendError } from './errors';

/** POST /stream {url}: a direct audio link for the phone to play or save. Nothing is proxied. */
export const streamRoutes: FastifyPluginAsync<RouteOptions> = async (app, { config }) => {
  const cache = createResolveCache<StreamResponse>({
    ttlMs: config.streamCacheTtl * 1000,
    resolve: resolveStream,
  });

  app.post<{ Body: { url: string } }>(
    '/stream',
    {
      schema: {
        body: {
          type: 'object',
          required: ['url'],
          properties: { url: { type: 'string', minLength: 1, maxLength: 4096 } },
        },
      },
      config: {
        rateLimit: {
          max: config.resolveRateLimitMax,
          timeWindow: '1 minute',
          keyGenerator: (request) => tokenKey(request.headers.authorization),
        },
      },
    },
    async (request, reply) => {
      try {
        return await cache.get(await validateUrl(request.body.url));
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );
};
