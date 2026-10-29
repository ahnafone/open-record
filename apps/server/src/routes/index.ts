import type { FastifyPluginAsync } from 'fastify';
import type { ServerConfig } from '../config';
import type { VerifyToken } from '../plugins/auth';
import type { SessionService } from '../services/session';
import { appConfigRoutes, healthRoutes, pingRoutes } from './health';
import { metaRoutes } from './meta';
import { playlistRoutes } from './playlist';
import { searchRoutes } from './search';
import { sessionRoutes } from './session';
import { streamRoutes } from './stream';

/** Options every route plugin receives. */
export interface RouteOptions {
  config: ServerConfig;
  /** Pre-bound: `verifyToken(value)` using the static token + Supabase verifier. */
  verifyToken?: VerifyToken;
  /** Session state machine; absent when SESSION_ENABLED=false (routes answer 503). */
  sessions?: SessionService;
  // Placeholders: Phase 5 narrows these to their real services.
  relay?: unknown;
  cast?: unknown;
  uploads?: unknown;
}

/**
 * Route plugins registered by `buildApp`. To add a feature, create
 * `src/routes/<feature>.ts` (and any helpers in `src/services/`) and append
 * the plugin here. All routes require the bearer token unless they set
 * `config: { public: true }`.
 */
export const routes: FastifyPluginAsync<RouteOptions>[] = [
  healthRoutes,
  pingRoutes,
  appConfigRoutes,
  searchRoutes,
  streamRoutes,
  metaRoutes,
  playlistRoutes,
  sessionRoutes,
];
