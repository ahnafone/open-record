import type { FastifyPluginAsync } from 'fastify';

/** Unauthenticated liveness probe (used by Docker healthcheck and the app's "Test connection"). */
export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get('/health', { config: { public: true } }, async () => ({ status: 'ok' }));
};
