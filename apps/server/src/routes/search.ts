import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { rateLimitKey } from '../plugins/auth';
import { guestHostRefused, validateUrlString } from '../services/url-guard';
import {
  MAX_QUERY_LENGTH,
  resolveUrl,
  search,
  SEARCH_SOURCES,
  type Lane,
  type SearchSource,
} from '../services/ytdlp';
import type { RouteOptions } from './index';
import { sendError } from './errors';

/** Guests run in the guest lane (capped slots, supported sites only); everyone else in the member lane. */
export const laneOf = (request: Pick<FastifyRequest, 'guest'>): Lane => (request.guest ? 'guest' : 'member');

/** GET /search and POST /resolve (metadata only, nothing is downloaded). */
export const searchRoutes: FastifyPluginAsync<RouteOptions> = async (app, { config }) => {
  const rateLimit = {
    max: config.resolveRateLimitMax,
    timeWindow: '1 minute',
    keyGenerator: rateLimitKey,
  };

  app.get<{ Querystring: { q: string; source?: SearchSource } }>(
    '/search',
    {
      schema: {
        querystring: {
          type: 'object',
          required: ['q'],
          properties: {
            q: { type: 'string', minLength: 1, maxLength: MAX_QUERY_LENGTH },
            source: { type: 'string', enum: [...SEARCH_SOURCES], default: 'youtube' },
          },
        },
      },
      config: { rateLimit, guest: true },
    },
    async (request, reply) => {
      const q = request.query.q.trim();
      if (!q) return reply.code(400).send({ error: 'q is required' });
      try {
        return {
          results: await search(q, request.query.source ?? 'youtube', laneOf(request)),
        };
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.post<{ Body: { url: string } }>(
    '/resolve',
    {
      schema: {
        body: {
          type: 'object',
          required: ['url'],
          properties: { url: { type: 'string', minLength: 1, maxLength: 4096 } },
        },
      },
      config: { rateLimit, guest: true },
    },
    async (request, reply) => {
      if (request.guest && guestHostRefused(request.body.url, config.guestAllowedHosts)) {
        return reply.code(403).send({ error: 'guest_host_not_allowed' });
      }
      try {
        return await resolveUrl(await validateUrlString(request.body.url), laneOf(request));
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );
};
