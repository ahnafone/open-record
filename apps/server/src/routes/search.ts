import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { UrlRejectedError, validateUrl } from '../services/url-guard';
import {
  MAX_QUERY_LENGTH,
  resolveUrl,
  search,
  SEARCH_SOURCES,
  YtDlpError,
  type SearchSource,
} from '../services/ytdlp';

function sendError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof UrlRejectedError) return reply.code(400).send({ error: err.message });
  if (err instanceof YtDlpError) return reply.code(err.status).send({ error: err.message });
  throw err;
}

/** GET /search and POST /resolve (metadata only, nothing is downloaded). */
export const searchRoutes: FastifyPluginAsync = async (app) => {
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
