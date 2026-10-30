import type { FastifyPluginAsync } from 'fastify';
import type { ServerConfig } from '../config';
import type { VerifyToken } from '../plugins/auth';
import type { CastService } from '../services/cast';
import type { MediaRelay } from '../services/media-relay';
import type { SessionService } from '../services/session';
import type { StreamResponse } from '../services/ytdlp';
import type { ValidatedUrl } from '../services/url-guard';
import { castRoutes } from './cast';
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
  // Phase 5 services; `relay` is null when casting is disabled.
  relay?: MediaRelay | null;
  cast?: CastService | null;
  uploads?: unknown;
  /** Injected by `buildApp`; the relay falls back to the real resolver in tests. */
  resolveStream?: (url: string) => Promise<StreamResponse>;
  /** HTTPS/HTTP fetch validation; tests pin it to a local fixture. */
  validateRelayUrl?: (url: string) => Promise<ValidatedUrl>;
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
  castRoutes,
];
