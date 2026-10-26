import fastifyStatic from '@fastify/static';
import { existsSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';

/** First path segments owned by the API; never answered with the web app. */
const API_SEGMENTS = new Set(['health', 'ping', 'app-config', 'search', 'resolve', 'stream']);

/** True when `dir` holds a built web app (an index.html). */
export function hasWebApp(dir: string): boolean {
  return existsSync(join(dir, 'index.html'));
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

const acceptsHtml = (request: FastifyRequest): boolean =>
  (request.headers.accept ?? '').includes('text/html');

/**
 * Serves the built web app from `webDir` at `/` (public, no token): real files
 * as-is, and index.html for other GET navigations (SPA fallback). API routes
 * are more specific and win; paths under an API segment are never served.
 */
export async function registerWebApp(app: FastifyInstance, webDir: string): Promise<void> {
  const root = resolve(webDir);
  await app.register(fastifyStatic, { root, serve: false });

  app.get<{ Params: { '*': string } }>(
    '/*',
    { config: { public: true } },
    async (request, reply) => {
      const rel = request.params['*'] ?? '';
      const segments = rel.split('/');
      if (API_SEGMENTS.has(segments[0]) || segments.some((s) => s.startsWith('.'))) {
        return reply.code(404).send({ error: 'not found' });
      }

      const file = resolve(root, rel);
      if (rel && file.startsWith(root + sep) && isFile(file)) {
        return reply.sendFile(rel);
      }
      if (rel === '' || acceptsHtml(request)) {
        // index.html must not be cached, so new builds are picked up.
        reply.header('cache-control', 'no-cache');
        return reply.sendFile('index.html', { cacheControl: false });
      }
      return reply.code(404).send({ error: 'not found' });
    },
  );
}
