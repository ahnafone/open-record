import type { FastifyPluginAsync } from 'fastify';
import { rateLimitKey } from '../plugins/auth';
import { MAX_ENRICH_BATCH, type EnrichQuery } from '@open-record/models';
import { enrichBatch, MAX_ENRICH_FIELD } from '../services/enrich';
import { aliasLookup, MAX_ALIAS_FIELD } from '../services/musicbrainz';
import type { RouteOptions } from './index';

/**
 * GET /meta/aliases: alternative titles/artist names from MusicBrainz (fails soft to empty lists).
 * POST /meta/enrich: catalogue matches (confident, else up to 3 weaker suggestions) (YT Music, iTunes, Deezer, MusicBrainz) for a batch of songs.
 */
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

  app.post<{ Body: { items: EnrichQuery[] } }>(
    '/meta/enrich',
    {
      schema: {
        body: {
          type: 'object',
          required: ['items'],
          properties: {
            items: {
              type: 'array',
              minItems: 1,
              maxItems: MAX_ENRICH_BATCH,
              items: {
                type: 'object',
                required: ['title'],
                additionalProperties: false,
                properties: {
                  title: { type: 'string', minLength: 1, maxLength: MAX_ENRICH_FIELD },
                  artist: { type: 'string', maxLength: MAX_ENRICH_FIELD, default: '' },
                  album: { type: 'string', maxLength: MAX_ENRICH_FIELD },
                  durationSec: { type: 'number', minimum: 0, maximum: 86400 },
                },
              },
            },
          },
        },
      },
      config: { rateLimit },
    },
    async (request) => ({ results: await enrichBatch(request.body.items) }),
  );
};
