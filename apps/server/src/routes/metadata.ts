import type { FastifyPluginAsync } from 'fastify';
import { lookupMetadata } from '../services/metadata';

interface MetadataQuerystring {
  title: string;
  artist?: string;
  durationSec?: number;
}

/** `GET /metadata?title=&artist=&durationSec=` -> `{ match: MetadataMatch | null }` (iTunes + Deezer). */
export const metadataRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: MetadataQuerystring }>(
    '/metadata',
    {
      schema: {
        querystring: {
          type: 'object',
          required: ['title'],
          additionalProperties: false,
          properties: {
            title: { type: 'string', minLength: 1, maxLength: 300 },
            artist: { type: 'string', maxLength: 300 },
            durationSec: { type: 'number', minimum: 0, maximum: 86_400 },
          },
        },
      },
    },
    async (request, reply) => {
      const { title, artist, durationSec } = request.query;
      try {
        const match = await lookupMetadata(
          { title, artist, durationSec },
          { onProviderError: (source, err) => request.log.warn({ source, err: String(err) }, 'metadata provider failed') },
        );
        return { match };
      } catch (err) {
        request.log.warn({ err: String(err) }, 'metadata lookup failed');
        return reply.code(502).send({ error: 'metadata providers unavailable' });
      }
    },
  );
};
