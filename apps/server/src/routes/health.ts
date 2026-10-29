import type { FastifyPluginAsync } from 'fastify';
import type { RouteOptions } from './index';

/** Unauthenticated liveness probe (`npm run server:up` waits for it; uptime checks use it too). */
export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get('/health', { config: { public: true } }, async () => ({ status: 'ok' }));
};

/** Authenticated probe: the app's "Test connection" checks the token with it. */
export const pingRoutes: FastifyPluginAsync = async (app) => {
  app.get('/ping', async () => ({ status: 'ok' }));
};

/**
 * Public client config (no token): the Supabase URL and anon key the web app
 * signs in with. Both are public values; the JWT secret is never included.
 */
export const appConfigRoutes: FastifyPluginAsync<RouteOptions> = async (app, { config }) => {
  app.get('/app-config', { config: { public: true } }, async (_request, reply) => {
    reply.header('cache-control', 'no-store');
    const { supabaseUrl, supabaseAnonKey } = config.appConfig;
    return { supabaseUrl, supabaseAnonKey };
  });
};
