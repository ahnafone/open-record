import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Set `config: { public: true }` on a route to skip bearer-token auth. */
    public?: boolean;
  }
}

const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();

/**
 * Constant-time token comparison. Both sides are hashed first so the
 * comparison never leaks the expected token's length.
 */
export function tokenMatches(presented: string, expected: string): boolean {
  return timingSafeEqual(digest(presented), digest(expected));
}

/**
 * Adds a root-level onRequest hook that requires `Authorization: Bearer <token>`
 * on every route except those marked `config: { public: true }`. Unknown routes
 * (404s) also require auth so the route table cannot be probed anonymously.
 */
export function registerAuth(app: FastifyInstance, token: string): void {
  app.addHook('onRequest', async (request, reply) => {
    if (request.routeOptions.config?.public) return;

    const header = request.headers.authorization ?? '';
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match || !tokenMatches(match[1].trim(), token)) {
      reply.header('WWW-Authenticate', 'Bearer');
      return reply.code(401).send({ error: 'unauthorized' });
    }
  });
}
