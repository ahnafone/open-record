import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { RouteOptions } from './routes';
import { castRoutes } from './routes/cast';

/**
 * A second listener that serves ONLY the cast media relay (`GET /cast/relay/:token`).
 *
 * Speakers must reach the relay over the LAN, but the main API is bound to
 * loopback behind the Cloudflare Tunnel. Serving the whole API on the LAN would
 * expose every bearer-protected route to any LAN host, so the relay gets its own
 * Fastify instance with no auth hooks, no CORS, no session/search/stream routes
 * and no web app. Everything else on this listener is a plain 404.
 *
 * The relay token is still the only credential: an HMAC over an in-memory entry,
 * so an unknown or forged token gets the same 404 as before. Trust proxy is off
 * here: no proxy sits in front of this listener, so `request.ip` is the peer.
 */
export async function buildCastRelayApp(
  routeOptions: RouteOptions,
  logger: FastifyServerOptions['logger'] = false,
): Promise<FastifyInstance> {
  const app = Fastify({ logger, trustProxy: false });
  // Route-level `config.rateLimit` (set by castRoutes) needs the plugin; `global:
  // false` keeps it off every route that does not ask for it.
  await app.register(rateLimit, { global: false });
  await app.register(castRoutes, routeOptions);
  return app;
}
