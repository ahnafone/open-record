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
import { type AccessGate } from '../services/access-gate';
import { clientAddress, clientKey } from '../services/client-ip';
import { createFixedWindow } from '../services/fixed-window';

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
 * Rate-limit key for per-client limits: the Supabase user when signed in, and
 * otherwise the client (IP) so public routes and the static token are keyed by
 * address. Keying unauthenticated requests on the presented header would let a
 * client mint a new bucket per header value.
 */
export function rateLimitKey(
  request: Pick<FastifyRequest, 'userId' | 'ip' | 'headers' | 'socket'>,
): string {
  if (request.userId) return `user:${request.userId}`;
  return `ip:${clientKey(clientAddress(request))}`;
}

/**
 * Reads `exp` (unix seconds) from a JWT payload WITHOUT verifying it. Used only
 * after a token has already failed verification, to tell an expired credential
 * (the client refreshes and retries) from a refused one. Never authenticates.
 */
export function unverifiedExpiry(value: string): number | undefined {
  const parts = value.split('.');
  if (parts.length !== 3) return undefined;
  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8'));
    if (typeof payload !== 'object' || payload === null) return undefined;
    const exp = (payload as Record<string, unknown>)['exp'];
    return typeof exp === 'number' && Number.isFinite(exp) ? exp : undefined;
  } catch {
    return undefined;
  }
}

/**
 * True for a JWT-shaped credential whose expiry has passed. Such a request is a
 * normal refresh (the client gets 401 and re-signs in), so it does not count
 * toward the failed-auth budget. The exemption can only lower the cost of
 * guessing a Supabase signature, which is not feasible; a random static token
 * with no dots can never match a JWT-shaped guess.
 */
function isExpiredJwt(value: string): boolean {
  if (!JWT_SHAPE.test(value)) return false;
  const exp = unverifiedExpiry(value);
  return exp !== undefined && exp <= Math.floor(Date.now() / 1000);
}

/** Failed bearer checks per client per minute before the client gets 429. */
const AUTH_FAILURES_MAX = 30;
const AUTH_FAILURES_WINDOW_MS = 60_000;
/** Hard cap on clients tracked by the failed-auth counter. */
const AUTH_FAILURE_KEYS_MAX = 10_000;

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
 *
 * Brute-force guard: a refused request on a non-public route that presented a
 * bearer value counts against its client (IP). Requests with no Authorization
 * header and JWTs that failed only because they expired are refused with `401`
 * but not counted, since clients send those during normal refresh. Past the
 * budget a counted client gets `429` with `Retry-After`. Verification runs
 * first, so a valid token is never refused or counted.
 *
 * Approval gate (public mode, `REQUIRE_APPROVAL`): a verified Supabase user the
 * gate refuses gets `403 access-not-approved`. That is not a credential
 * failure, so it is neither counted nor answered with `WWW-Authenticate`. The
 * static token (`userId: null`) skips the gate.
 */
export function registerAuth(app: FastifyInstance, verify: VerifyToken, gate?: AccessGate): void {
  app.decorateRequest('userId', null);
  app.decorateRequest('userExp', null);
  const failedAuth = createFixedWindow({
    max: AUTH_FAILURES_MAX,
    windowMs: AUTH_FAILURES_WINDOW_MS,
    maxKeys: AUTH_FAILURE_KEYS_MAX,
  });
  app.addHook('onRequest', async (request, reply) => {
    if (request.routeOptions.config?.public) return;

    const header = request.headers.authorization ?? '';
    const match = /^Bearer\s+(.+)$/i.exec(header);
    const presented = match?.[1].trim() ?? '';
    const verified = presented ? await verify(presented) : null;
    if (verified) {
      if (gate && verified.userId !== null && !(await gate(verified.userId))) {
        return reply.code(403).send({ error: 'access-not-approved' });
      }
      request.userId = verified.userId;
      request.userExp = verified.exp ?? null;
      return;
    }
    if (presented && !isExpiredJwt(presented)) {
      const retryAfter = failedAuth(clientKey(clientAddress(request)));
      if (retryAfter > 0) {
        reply.header('Retry-After', String(retryAfter));
        return reply.code(429).send({ error: 'too-many-requests' });
      }
    }
    reply.header('WWW-Authenticate', 'Bearer');
    return reply.code(401).send({ error: 'unauthorized' });
  });
}
