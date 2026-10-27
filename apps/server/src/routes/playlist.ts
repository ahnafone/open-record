import type { FastifyPluginAsync } from 'fastify';
import { rateLimitKey } from '../plugins/auth';
import { fetchPlaylist, fetchSong, parseYoutubeLink } from '../services/playlist';
import { MAX_URL_LENGTH } from '../services/url-guard';
import type { RouteOptions } from './index';
import { sendError } from './errors';

/** POST /playlist: a public YouTube / YT Music playlist's entries, or one song's metadata (nothing is downloaded). */
export const playlistRoutes: FastifyPluginAsync<RouteOptions> = async (app, { config }) => {
  const rateLimit = {
    max: config.resolveRateLimitMax,
    timeWindow: '1 minute',
    keyGenerator: rateLimitKey,
  };

  app.post<{ Body: { url: string } }>(
    '/playlist',
    {
      schema: {
        body: {
          type: 'object',
          required: ['url'],
          properties: { url: { type: 'string', minLength: 1, maxLength: MAX_URL_LENGTH } },
        },
      },
      config: { rateLimit },
    },
    async (request, reply) => {
      try {
        const target = parseYoutubeLink(request.body.url);
        return target.kind === 'song' ? await fetchSong(target) : await fetchPlaylist(target);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );
};
