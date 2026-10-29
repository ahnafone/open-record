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
import { SessionService } from './services/session';
import { configureResolveLimits } from './services/ytdlp';

export interface BuildAppOptions {
  logger?: FastifyServerOptions['logger'];
  /** Override the route list (tests). Defaults to `src/routes/index.ts`. */
  routes?: FastifyPluginAsync<RouteOptions>[];
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

  for (const route of options.routes ?? defaultRoutes) {
    await app.register(route, { config, verifyToken: verify, sessions: sessions ?? undefined });
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
