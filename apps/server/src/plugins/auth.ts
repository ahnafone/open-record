import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
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
    /**
     * Set `config: { public: true }` on a route to skip bearer-token auth.
     * Public routes: GET /health, GET /app-config and the web app (WEB_DIR).
     */
    public?: boolean;
  }
  interface FastifyRequest {
    /**
     * Supabase user id (`sub`) when the request carried a valid Supabase access
     * token; null for the static token (legacy single-user mode) and public routes.
     */
    userId: string | null;
    /** Expiry (`exp`, unix seconds) of the verified Supabase token; null otherwise. */
    userExp: number | null;
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

/**
 * Verifies a bearer value as a Supabase access token; resolves to the user id
 * and the token's expiry (unix seconds), or null.
 */
export type JwtVerifier = (token: string) => Promise<{ userId: string; exp?: number } | null>;

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
      if (typeof payload.sub !== 'string' || !payload.sub) return null;
      return { userId: payload.sub, exp: payload.exp };
    } catch {
      return null;
    }
  };
}

/** A checked credential: the static token (`userId: null`) or a Supabase JWT. */
export interface VerifiedToken {
  /** Supabase user id; null only for the static token. */
  userId: string | null;
  /** JWT expiry (unix seconds) when signed with one. */
  exp?: number;
  kind: 'static' | 'jwt';
}

/** Verifies a presented bearer value; pre-bound to the config by `buildApp`. */
export type VerifyToken = (value: string) => Promise<VerifiedToken | null>;

/**
 * Verifies the static token or a Supabase JWT. The static token is compared in
 * constant time and reported with `userId: null`, which lets session routes
 * refuse it with 403 while legacy routes keep accepting it.
 */
export async function verifyToken(
  value: string,
  staticToken: string,
  verifyJwt?: JwtVerifier,
): Promise<VerifiedToken | null> {
  if (value && tokenMatches(value, staticToken)) return { userId: null, kind: 'static' };
  const verified = verifyJwt ? await verifyJwt(value) : null;
  if (!verified) return null;
  return { userId: verified.userId, exp: verified.exp, kind: 'jwt' };
}

/**
 * Rate-limit key for per-client limits: the Supabase user when signed in, a
 * hash of the presented credential (the static token) when one was sent, and
 * otherwise the client IP so public routes are still keyed.
 */
export function rateLimitKey(
  request: Pick<FastifyRequest, 'userId' | 'headers' | 'ip'>,
): string {
  if (request.userId) return `user:${request.userId}`;
  if (request.headers.authorization) return tokenKey(request.headers.authorization);
  return `ip:${request.ip}`;
}

/**
 * Pre-handler guard for account-only routes (`/session/*`, `/cast/uploads*`):
 * the static token is authenticated but not an account, so it gets 403.
 */
export async function requireAccount(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (request.userId === null) {
    await reply.code(403).send({ error: 'account-required' });
  }
}

/**
 * Adds a root-level onRequest hook that requires `Authorization: Bearer <token>`
 * on every route except those marked `config: { public: true }`. Unknown routes
 * (404s) also require auth so the route table cannot be probed anonymously.
 *
 * `verify` is pre-bound by `buildApp`: it accepts the static token (legacy
 * single-user mode) and Supabase access tokens. A verified user id is exposed
 * as `request.userId`, and a JWT's expiry as `request.userExp`.
 */
export function registerAuth(app: FastifyInstance, verify: VerifyToken): void {
  app.decorateRequest('userId', null);
  app.decorateRequest('userExp', null);
  app.addHook('onRequest', async (request, reply) => {
    if (request.routeOptions.config?.public) return;

    const header = request.headers.authorization ?? '';
    const match = /^Bearer\s+(.+)$/i.exec(header);
    const presented = match?.[1].trim() ?? '';
    const verified = presented ? await verify(presented) : null;
    if (verified) {
      request.userId = verified.userId;
      request.userExp = verified.exp ?? null;
      return;
    }
    reply.header('WWW-Authenticate', 'Bearer');
    return reply.code(401).send({ error: 'unauthorized' });
  });
}
