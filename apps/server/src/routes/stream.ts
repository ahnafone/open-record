import { AUDIO_QUALITIES, DEFAULT_AUDIO_QUALITY, type AudioQuality } from '@open-record/models';
import type { FastifyPluginAsync } from 'fastify';
import { rateLimitKey } from '../plugins/auth';
import { canonicalMediaKey, createResolveCache, type ResolveCache } from '../services/stream-cache';
import { resolveStream, type Lane, type StreamResponse } from '../services/ytdlp';
import { guestHostRefused, validateUrlString } from '../services/url-guard';
import type { RouteOptions } from './index';
import { sendError } from './errors';
import { laneOf } from './search';

/**
 * POST /stream {url, quality?}: a direct audio link for the phone to play or
 * save. Nothing is proxied or downloaded. `quality` (default `highest`) picks
 * the bitrate cap; each level has its own link cache per lane, so a guest's
 * resolve never fills or reads the member cache.
 */
export const streamRoutes: FastifyPluginAsync<RouteOptions> = async (app, { config }) => {
  const caches = new Map<string, ResolveCache<StreamResponse>>();
  const cacheFor = (quality: AudioQuality, lane: Lane): ResolveCache<StreamResponse> => {
    const key = `${lane}:${quality}`;
    let cache = caches.get(key);
    if (!cache) {
      cache = createResolveCache<StreamResponse>({
        ttlMs: config.streamCacheTtl * 1000,
        resolve: (url) => resolveStream(url, quality, lane),
        key: canonicalMediaKey,
      });
      caches.set(key, cache);
    }
    return cache;
  };

  app.post<{ Body: { url: string; quality?: AudioQuality } }>(
    '/stream',
    {
      schema: {
        body: {
          type: 'object',
          required: ['url'],
          properties: {
            url: { type: 'string', minLength: 1, maxLength: 4096 },
            quality: { type: 'string', enum: [...AUDIO_QUALITIES] },
          },
        },
      },
      config: {
        guest: true,
        rateLimit: {
          max: config.resolveRateLimitMax,
          timeWindow: '1 minute',
          keyGenerator: rateLimitKey,
        },
      },
    },
    async (request, reply) => {
      if (request.guest && guestHostRefused(request.body.url, config.guestAllowedHosts)) {
        return reply.code(403).send({ error: 'guest_host_not_allowed' });
      }
      try {
        const quality = request.body.quality ?? DEFAULT_AUDIO_QUALITY;
        return await cacheFor(quality, laneOf(request)).get(await validateUrlString(request.body.url));
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );
};
