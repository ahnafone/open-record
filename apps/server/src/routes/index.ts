import type { FastifyPluginAsync } from 'fastify';
import type { ServerConfig } from '../config';
import { healthRoutes, pingRoutes } from './health';
import { searchRoutes } from './search';
import { streamRoutes } from './stream';

/** Options every route plugin receives. */
export interface RouteOptions {
  config: ServerConfig;
}

/**
 * Route plugins registered by `buildApp`. To add a feature, create
 * `src/routes/<feature>.ts` (and any helpers in `src/services/`) and append
 * the plugin here. All routes require the bearer token unless they set
 * `config: { public: true }`.
 */
export const routes: FastifyPluginAsync<RouteOptions>[] = [healthRoutes, pingRoutes, searchRoutes, streamRoutes];
