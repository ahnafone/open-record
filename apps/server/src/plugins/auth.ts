import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  createRemoteJWKSet,
  decodeProtectedHeader,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from 'jose';
import type { SupabaseAuthConfig } from '../config';
import { tokenKey } from '../services/stream-cache';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Set `config: { public: true }` on a route to skip bearer-token auth. */
    public?: boolean;
  }
  interface FastifyRequest {
    /**
     * Supabase user id (`sub`) when the request carried a valid Supabase access
     * token; null for the static token (legacy single-user mode) and public routes.
     */
    userId: string | null;
  }
}

const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();

/**
 * Constant-time token comparison. Both sides are hashed first so the
 * comparison never leaks the expected token's length.
 */
export function tokenMatches(presented: string, expected: string): boolean {
  return timingSafeEqual(digest(presented), digest(expected));
}

/** Verifies a bearer value as a Supabase access token; resolves to the user id or null. */
export type JwtVerifier = (token: string) => Promise<string | null>;

const JWT_SHAPE = /^[\w-]+\.[\w-]+\.[\w-]+$/;
const ASYMMETRIC = ['ES256', 'RS256', 'EdDSA'];

/**
 * Builds a verifier for Supabase access tokens: HS256 with the shared JWT
 * secret, and/or asymmetric keys from the project's JWKS endpoint. Only
 * signed-in user tokens pass (`aud: authenticated` with a `sub`), so the
 * public anon key is not a credential.
 */
export function createSupabaseVerifier(
  config: SupabaseAuthConfig,
  jwks: JWTVerifyGetKey | undefined = config.jwksUrl
    ? createRemoteJWKSet(new URL(config.jwksUrl))
    : undefined,
): JwtVerifier {
  const secret = config.jwtSecret ? new TextEncoder().encode(config.jwtSecret) : undefined;
  const options = { audience: 'authenticated', requiredClaims: ['exp', 'sub'] };

  return async (token) => {
    if (!JWT_SHAPE.test(token)) return null;
    try {
      const { alg } = decodeProtectedHeader(token);
      let payload: JWTPayload;
      if (alg === 'HS256' && secret) {
        ({ payload } = await jwtVerify(token, secret, { ...options, algorithms: ['HS256'] }));
      } else if (alg && ASYMMETRIC.includes(alg) && jwks) {
        ({ payload } = await jwtVerify(token, jwks, { ...options, algorithms: ASYMMETRIC }));
      } else {
        return null;
      }
      return typeof payload.sub === 'string' && payload.sub ? payload.sub : null;
    } catch {
      return null;
    }
  };
}

/**
 * Rate-limit key for per-client limits: the Supabase user when signed in,
 * otherwise a hash of the presented credential (the static token).
 */
export function rateLimitKey(request: Pick<FastifyRequest, 'userId' | 'headers'>): string {
  return request.userId ? `user:${request.userId}` : tokenKey(request.headers.authorization);
}

/**
 * Adds a root-level onRequest hook that requires `Authorization: Bearer <token>`
 * on every route except those marked `config: { public: true }`. Unknown routes
 * (404s) also require auth so the route table cannot be probed anonymously.
 *
 * The static token is always accepted (legacy single-user mode). When
 * `verifyJwt` is given, a valid Supabase access token is accepted too and
 * its user id is exposed as `request.userId`.
 */
export function registerAuth(app: FastifyInstance, token: string, verifyJwt?: JwtVerifier): void {
  app.decorateRequest('userId', null);
  app.addHook('onRequest', async (request, reply) => {
    if (request.routeOptions.config?.public) return;

    const header = request.headers.authorization ?? '';
    const match = /^Bearer\s+(.+)$/i.exec(header);
    const presented = match?.[1].trim() ?? '';
    if (presented && tokenMatches(presented, token)) return;

    const userId = presented && verifyJwt ? await verifyJwt(presented) : null;
    if (userId) {
      request.userId = userId;
      return;
    }
    reply.header('WWW-Authenticate', 'Bearer');
    return reply.code(401).send({ error: 'unauthorized' });
  });
}
