import type { FastifyPluginAsync } from 'fastify';

/** Unauthenticated liveness probe (used by Docker healthcheck). */
export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get('/health', { config: { public: true } }, async () => ({ status: 'ok' }));
};

/** Authenticated probe: the app's "Test connection" checks the token with it. */
export const pingRoutes: FastifyPluginAsync = async (app) => {
  app.get('/ping', async () => ({ status: 'ok' }));
};
