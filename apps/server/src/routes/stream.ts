import { AUDIO_QUALITIES, DEFAULT_AUDIO_QUALITY, type AudioQuality } from '@open-record/models';
import type { FastifyPluginAsync } from 'fastify';
import { rateLimitKey } from '../plugins/auth';
import { createResolveCache, type ResolveCache } from '../services/stream-cache';
import { resolveStream, type StreamResponse } from '../services/ytdlp';
import { validateUrl } from '../services/url-guard';
import type { RouteOptions } from './index';
import { sendError } from './errors';

/**
 * POST /stream {url, quality?}: a direct audio link for the phone to play or
 * save. Nothing is proxied or downloaded. `quality` (default `highest`) picks
 * the bitrate cap; each level has its own link cache.
 */
export const streamRoutes: FastifyPluginAsync<RouteOptions> = async (app, { config }) => {
  const caches = new Map<AudioQuality, ResolveCache<StreamResponse>>();
  const cacheFor = (quality: AudioQuality): ResolveCache<StreamResponse> => {
    let cache = caches.get(quality);
    if (!cache) {
      cache = createResolveCache<StreamResponse>({
        ttlMs: config.streamCacheTtl * 1000,
        resolve: (url) => resolveStream(url, quality),
      });
      caches.set(quality, cache);
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
        rateLimit: {
          max: config.resolveRateLimitMax,
          timeWindow: '1 minute',
          keyGenerator: rateLimitKey,
        },
      },
    },
    async (request, reply) => {
      try {
        const quality = request.body.quality ?? DEFAULT_AUDIO_QUALITY;
        return await cacheFor(quality).get(await validateUrl(request.body.url));
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );
};
