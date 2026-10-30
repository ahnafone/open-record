import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import { WS_MAX_PAYLOAD_BYTES } from '@open-record/models';
import Fastify, {
  type FastifyInstance,
  type FastifyPluginAsync,
  type FastifyServerOptions,
} from 'fastify';
import type { ServerConfig } from './config';
import {
  createSupabaseVerifier,
  rateLimitKey,
  registerAuth,
  verifyToken,
  type VerifyToken,
} from './plugins/auth';
import { hasWebApp, registerWebApp } from './plugins/web';
import { routes as defaultRoutes, type RouteOptions } from './routes';
import { CastService } from './services/cast';
import { CastDiscovery } from './services/cast-discovery';
import { loadOrCreateCastSecret, MediaRelay } from './services/media-relay';
import { SessionService } from './services/session';
import { UploadCache } from './services/upload-cache';
import { configureResolveLimits, resolveStream, type StreamResponse } from './services/ytdlp';
import { validateUrl, type ValidatedUrl } from './services/url-guard';

/** Cast services a caller (tests) can inject instead of constructing them. */
export interface CastServices {
  relay: MediaRelay;
  cast?: CastService | null;
  /** Upload cache for PC-imported audio; absent means `/cast/uploads*` is disabled. */
  uploads?: UploadCache;
  resolveStream?: (url: string) => Promise<StreamResponse>;
  validateRelayUrl?: (url: string) => Promise<ValidatedUrl>;
}

export interface BuildAppOptions {
  logger?: FastifyServerOptions['logger'];
  /** Override the route list (tests). Defaults to `src/routes/index.ts`. */
  routes?: FastifyPluginAsync<RouteOptions>[];
  /**
   * Test seam: omit to build the real services from config, pass an object to
   * inject fakes (the caller then owns their disposal), or `false` to disable.
   */
  cast?: CastServices | false;
}

/** Builds the Fastify instance: CORS, rate limit, bearer auth, then route plugins. */
export async function buildApp(
  config: ServerConfig,
  options: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? false,
    trustProxy: config.trustProxy,
  });

  // Order matters: CORS answers preflights and rate limiting throttles before
  // the auth hook runs, so token guessing is rate limited too.
  await app.register(cors, {
    origin: config.corsOrigin,
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Device-Id', 'Range'],
  });
  await app.register(rateLimit, {
    max: config.rateLimitMax,
    timeWindow: '1 minute',
    keyGenerator: rateLimitKey,
  });
  // Before the routes: the plugin rewrites `websocket: true` routes.
  await app.register(websocket, { options: { maxPayload: WS_MAX_PAYLOAD_BYTES } });

  // Pre-bind the credential helper so routes never see the static token.
  const verifyJwt = config.supabase ? createSupabaseVerifier(config.supabase) : undefined;
  const verify: VerifyToken = (value) => verifyToken(value, config.token, verifyJwt);
  registerAuth(app, verify);
  configureResolveLimits(config.maxConcurrentResolves);

  // Sessions are in-memory, so they only exist when enabled. `start()` uses an
  // unref-ed interval and `onClose` disposes it: tests and CLI runs still exit.
  const sessions = config.sessionEnabled
    ? new SessionService({
        idleTimeoutMin: config.sessionIdleTimeoutMin,
        targetStaleMin: config.sessionTargetStaleMin,
      })
    : null;
  if (sessions) {
    sessions.start();
    app.addHook('onClose', async () => sessions.dispose());
  }

  // Cast is optional and only meaningful with sessions: the speaker is a
  // target of the shared session. Without a media base URL (or with
  // CAST_ENABLED=false) nothing is constructed: no mDNS socket, no secret.
  let castServices: CastServices | null = null;
  let ownedCast: {
    discovery: CastDiscovery;
    cast: CastService;
    relay: MediaRelay;
  } | null = null;

  const attachCast = (cast: CastService): void => {
    if (!sessions) return;
    sessions.setCastHooks({
      devices: () => cast.devices(),
      onTarget: (userId, requester, previousCastId, next, opts) =>
        cast.setTarget(userId, requester, previousCastId, next, opts),
      onControl: (userId, castId, command) => cast.control(userId, castId, command),
      onState: (userId, castId, state) => cast.sync(userId, castId, state),
    });
    cast.setOnLost((ownerUserId, castId) => sessions.castLost(ownerUserId, castId));
    cast.setSession(sessions);
  };

  if (options.cast !== false) {
    if (options.cast) {
      castServices = options.cast;
      if (castServices.cast) attachCast(castServices.cast);
    } else if (config.castEnabled && sessions && config.castMediaBaseUrl) {
      const relay = new MediaRelay({
        secret: loadOrCreateCastSecret(config.dataDir),
        dataDir: config.dataDir,
        baseUrl: config.castMediaBaseUrl,
        ttlMs: config.castRelayTtlSec * 1000,
      });
      const discovery = new CastDiscovery();
      const cast = new CastService({ relay, discovery, config });
      // One cache per app: per-user cap (`CAST_CACHE_MB`) and the relay's live
      // upload ids decide what may be evicted or cleared.
      const uploads = new UploadCache({
        dataDir: config.dataDir,
        capBytes: config.castCacheMb * 1024 * 1024,
        maxUploadBytes: config.castUploadMaxMb * 1024 * 1024,
        liveUploads: () => relay.liveUploads(),
      });
      discovery.start();
      attachCast(cast);
      castServices = { relay, cast, uploads };
      ownedCast = { discovery, cast, relay };
    } else if (config.castEnabled && !castServices) {
      app.log.info('cast disabled: sessions or CAST_MEDIA_BASE_URL is unavailable');
    }
  }

  if (ownedCast) {
    const owned = ownedCast;
    app.addHook('onClose', async () => {
      owned.discovery.stop();
      owned.cast.dispose();
      owned.relay.dispose();
    });
  }

  const routeOptions: RouteOptions = {
    config,
    verifyToken: verify,
    sessions: sessions ?? undefined,
    relay: castServices?.relay ?? null,
    cast: castServices?.cast ?? null,
    // RouteOptions.uploads stays `unknown` for now; the upload plugin narrows it.
    uploads: castServices?.uploads,
    resolveStream:
      castServices?.resolveStream ?? ((url: string) => resolveStream(url, 'highest')),
    validateRelayUrl: castServices?.validateRelayUrl ?? validateUrl,
  };

  for (const route of options.routes ?? defaultRoutes) {
    await app.register(route, routeOptions);
  }

  if (config.webDir) {
    if (hasWebApp(config.webDir)) {
      await registerWebApp(app, config.webDir);
    } else {
      app.log.warn({ webDir: config.webDir }, 'WEB_DIR has no index.html; serving the API only');
    }
  }

  return app;
}
