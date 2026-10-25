import type { FastifyPluginAsync } from 'fastify';
import { tokenKey } from '../services/stream-cache';
import { validateUrl } from '../services/url-guard';
import { MAX_QUERY_LENGTH, resolveUrl, search, SEARCH_SOURCES, type SearchSource } from '../services/ytdlp';
import type { RouteOptions } from './index';
import { sendError } from './errors';

/** GET /search and POST /resolve (metadata only, nothing is downloaded). */
export const searchRoutes: FastifyPluginAsync<RouteOptions> = async (app, { config }) => {
  const rateLimit = {
    max: config.resolveRateLimitMax,
    timeWindow: '1 minute',
    keyGenerator: (request: { headers: { authorization?: string } }) => tokenKey(request.headers.authorization),
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
      config: { rateLimit },
    },
    async (request, reply) => {
      const q = request.query.q.trim();
      if (!q) return reply.code(400).send({ error: 'q is required' });
      try {
        return { results: await search(q, request.query.source ?? 'youtube') };
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
    },
    async (request, reply) => {
      try {
        return await resolveUrl(await validateUrl(request.body.url));
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );
};
