import type { FastifyPluginAsync } from 'fastify';
import { rateLimitKey } from '../plugins/auth';
import { aliasLookup, MAX_ALIAS_FIELD } from '../services/musicbrainz';
import type { RouteOptions } from './index';

/** GET /meta/aliases: alternative titles/artist names from MusicBrainz (fails soft to empty lists). */
export const metaRoutes: FastifyPluginAsync<RouteOptions> = async (app, { config }) => {
  const rateLimit = {
    max: config.resolveRateLimitMax,
    timeWindow: '1 minute',
    keyGenerator: rateLimitKey,
  };

  app.get<{ Querystring: { artist?: string; title: string; isrc?: string } }>(
    '/meta/aliases',
    {
      schema: {
        querystring: {
          type: 'object',
          required: ['title'],
          properties: {
            artist: { type: 'string', maxLength: MAX_ALIAS_FIELD, default: '' },
            title: { type: 'string', minLength: 1, maxLength: MAX_ALIAS_FIELD },
            isrc: { type: 'string', maxLength: 32 },
          },
        },
      },
      config: { rateLimit },
    },
    async (request, reply) => {
      const title = request.query.title.trim();
      if (!title) return reply.code(400).send({ error: 'title is required' });
      return aliasLookup.lookup({ artist: request.query.artist ?? '', title, isrc: request.query.isrc });
    },
  );
};
