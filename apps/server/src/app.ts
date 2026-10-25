import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify, {
  type FastifyInstance,
  type FastifyPluginAsync,
  type FastifyServerOptions,
} from 'fastify';
import type { ServerConfig } from './config';
import { registerAuth } from './plugins/auth';
import { routes as defaultRoutes, type RouteOptions } from './routes';
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
    allowedHeaders: ['Authorization', 'Content-Type'],
  });
  await app.register(rateLimit, {
    max: config.rateLimitMax,
    timeWindow: '1 minute',
  });
  registerAuth(app, config.token);
  configureResolveLimits(config.maxConcurrentResolves);

  for (const route of options.routes ?? defaultRoutes) {
    await app.register(route, { config });
  }

  return app;
}
