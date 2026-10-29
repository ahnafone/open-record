import {
  PRE_HELLO_MAX_BYTES,
  REST_BODY_LIMIT_BYTES,
  WS_PING_MS,
  WS_SILENCE_CLOSE_MS,
  type CommandResult,
  type SessionCommand,
  type SessionDevice,
  type SessionHello,
  type SessionReportMessage,
  type SessionServerMessage,
  type SessionSnapshot,
  type SessionState,
  type SessionUnchanged,
} from '@open-record/models';
import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { requireAccount } from '../plugins/auth';
import type { SessionConnection } from '../services/session';
import type { RouteOptions } from './index';

/** Close codes (application range): 4401 = expired, 4403 = refused for good. */
const CLOSE_EXPIRED = 4401;
const CLOSE_REFUSED = 4403;
const CLOSE_POLICY = 1008;
const CLOSE_INTERNAL = 1011;

/** Welcome/housekeeping limits (§1.7). */
const HELLO_DEADLINE_MS = 5_000;
const MAX_PRE_HELLO_PER_IP = 10;
const MAX_PRE_HELLO_GLOBAL = 100;
const MAX_AUTH_SOCKETS_PER_USER = 10;
const MAX_COMMANDS_PER_SECOND = 20;
const MAX_BUFFERED_BYTES = 1024 * 1024;
const MAX_ID_LEN = 128;
const MAX_DEVICE_NAME_LEN = 60;
const WS_OPEN = 1;

const PLATFORMS = ['android', 'ios', 'web'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= MAX_ID_LEN;
}

function isPlatform(value: unknown): value is SessionDevice['platform'] {
  return typeof value === 'string' && (PLATFORMS as readonly string[]).includes(value);
}

/** The hello device is client-supplied; only the fields the service stores survive. */
function readDevice(value: unknown): SessionDevice | null {
  if (!isRecord(value)) return null;
  const id = value['id'];
  const deviceId = value['deviceId'];
  const name = value['name'];
  const platform = value['platform'];
  const capabilities = value['capabilities'];
  if (!isId(id) || !isId(deviceId)) return null;
  if (typeof name !== 'string' || name.length < 1 || name.length > MAX_DEVICE_NAME_LEN) return null;
  if (!isPlatform(platform)) return null;
  if (!isRecord(capabilities)) return null;
  const cast = capabilities['cast'];
  const localFiles = capabilities['localFiles'];
  if (typeof cast !== 'boolean' || typeof localFiles !== 'boolean') return null;
  const model = value['model'];
  if (model !== undefined && (typeof model !== 'string' || model.length > MAX_DEVICE_NAME_LEN)) {
    return null;
  }
  return {
    id,
    deviceId,
    name,
    platform,
    online: true,
    lastSeenAt: Date.now(),
    capabilities: { cast, localFiles },
    ...(typeof model === 'string' && model ? { model } : {}),
  };
}

function readHello(value: unknown): SessionHello | null {
  if (!isRecord(value) || value['type'] !== 'hello') return null;
  const token = value['token'];
  if (typeof token !== 'string' || token.length < 1) return null;
  const device = readDevice(value['device']);
  if (!device) return null;
  return { type: 'hello', token, device };
}

function frameBytes(data: unknown): number {
  if (typeof data === 'string') return Buffer.byteLength(data, 'utf8');
  if (Buffer.isBuffer(data)) return data.byteLength;
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (Array.isArray(data)) {
    return data.reduce((total, chunk: Buffer) => total + chunk.byteLength, 0);
  }
  return Number.POSITIVE_INFINITY;
}

function frameText(data: unknown): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return '';
}

function parseFrame(data: unknown): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(frameText(data));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Reads `exp` from a JWT payload WITHOUT verifying it. Used only to tell an
 * expired credential (4401: refresh and reconnect) from a refused one (4403)
 * after `verifyToken` has already rejected the token. Never authenticates.
 */
function unverifiedExpiry(value: string): number | undefined {
  const parts = value.split('.');
  if (parts.length !== 3) return undefined;
  try {
    const payload: unknown = JSON.parse(
      Buffer.from(parts[1] ?? '', 'base64url').toString('utf8'),
    );
    if (!isRecord(payload)) return undefined;
    const exp = payload['exp'];
    return typeof exp === 'number' && Number.isFinite(exp) ? exp : undefined;
  } catch {
    return undefined;
  }
}

/** Route rate-limit key: `userId:clientId` from the device header (§1.7). */
function sessionRateLimitKey(request: FastifyRequest): string {
  const raw = request.headers['x-device-id'];
  const device = typeof raw === 'string' ? raw.slice(0, MAX_ID_LEN) : 'unknown';
  return `${request.userId ?? 'anon'}:${device}`;
}

/**
 * The `X-Device-Id` header must be present and match the clientId the request
 * acts for. Kept as a preHandler so schema validation runs first (400 on a
 * malformed query/body) and the account check still wins with 403.
 */
async function requireDeviceHeader(
  request: FastifyRequest,
  reply: FastifyReply,
  clientId: string | undefined,
): Promise<void> {
  if (reply.sent) return;
  const raw = request.headers['x-device-id'];
  if (typeof raw !== 'string' || raw.length < 1 || raw.length > MAX_ID_LEN) {
    await reply.code(400).send({ error: 'invalid-device-id' });
    return;
  }
  if (!clientId || raw !== clientId) {
    await reply.code(400).send({ error: 'device-mismatch' });
  }
}

function sessionsDisabled(reply: FastifyReply): FastifyReply {
  return reply.code(503).send({ error: 'sessions-disabled' });
}

/** The polling short-circuit: no queue, but presence and the anchor stay fresh. */
function unchangedFrom(snapshot: SessionSnapshot, session: SessionState): SessionUnchanged {
  return {
    unchanged: true,
    revision: session.revision,
    devicesRevision: snapshot.devicesRevision,
    serverTime: snapshot.serverTime,
    positionSec: session.positionSec,
    playing: session.playing,
    updatedAt: session.updatedAt,
    ...(session.targetStale ? { targetStale: true } : {}),
    devices: snapshot.devices,
  };
}

interface StateQuery {
  clientId: string;
  deviceId: string;
  name: string;
  platform: 'android' | 'ios' | 'web';
  cast: '0' | '1';
  localFiles: '0' | '1';
  since?: number;
}

interface CommandBody {
  clientId: string;
  id?: string;
  command: SessionCommand;
}

interface ReportBody {
  clientId: string;
  reason: SessionReportMessage['reason'];
  entryId: string;
  positionSec: number;
  playing: boolean;
  durationSec?: number;
}

/**
 * Session transport (§0.7): the WS room plus the REST polling routes used by
 * native clients. All state lives in `SessionService`; this plugin only
 * authenticates, validates the envelope and maps sockets to connections.
 */
export const sessionRoutes: FastifyPluginAsync<RouteOptions> = async (
  app,
  { sessions, verifyToken },
) => {
  // Public-route abuse counters (§1.7). In-memory because rooms are too.
  const preHelloByIp = new Map<string, number>();
  const authByUser = new Map<string, number>();
  let preHelloGlobal = 0;

  const ipFor = (request: FastifyRequest): string => {
    try {
      return request.ip || 'unknown';
    } catch {
      return 'unknown';
    }
  };

  app.get(
    '/session',
    {
      websocket: true,
      config: {
        public: true,
        rateLimit: {
          max: 20,
          timeWindow: '1 minute',
          keyGenerator: (request: FastifyRequest) => ipFor(request),
        },
      },
    },
    (socket, request) => {
      const ip = ipFor(request);
      const preHelloIpCount = preHelloByIp.get(ip) ?? 0;
      if (preHelloIpCount >= MAX_PRE_HELLO_PER_IP || preHelloGlobal >= MAX_PRE_HELLO_GLOBAL) {
        socket.close(CLOSE_REFUSED, 'too many pending connections');
        return;
      }
      preHelloByIp.set(ip, preHelloIpCount + 1);
      preHelloGlobal += 1;

      let preHelloHeld = true;
      let authHeld = false;
      let authenticated = false;
      let closed = false;
      let cleaned = false;
      let userId: string | null = null;
      let device: SessionDevice | null = null;
      let connection: SessionConnection | null = null;
      let lastActivity = Date.now();
      let commandTimes: number[] = [];

      let deadline: ReturnType<typeof setTimeout> | null = null;
      let pingTimer: ReturnType<typeof setInterval> | null = null;
      let expiryTimer: ReturnType<typeof setTimeout> | null = null;

      const releasePreHello = (): void => {
        if (!preHelloHeld) return;
        preHelloHeld = false;
        preHelloGlobal = Math.max(0, preHelloGlobal - 1);
        const count = (preHelloByIp.get(ip) ?? 1) - 1;
        if (count > 0) preHelloByIp.set(ip, count);
        else preHelloByIp.delete(ip);
      };

      const releaseAuth = (): void => {
        if (!authHeld || !userId) return;
        authHeld = false;
        const count = (authByUser.get(userId) ?? 1) - 1;
        if (count > 0) authByUser.set(userId, count);
        else authByUser.delete(userId);
      };

      const cleanup = (): void => {
        if (cleaned) return;
        cleaned = true;
        if (deadline) clearTimeout(deadline);
        if (pingTimer) clearInterval(pingTimer);
        if (expiryTimer) clearTimeout(expiryTimer);
        releasePreHello();
        releaseAuth();
        if (sessions && userId && connection) sessions.leave(userId, connection);
      };

      const reject = (code: number, reason: string): void => {
        if (closed) return;
        closed = true;
        cleanup();
        if (socket.readyState === WS_OPEN) socket.close(code, reason);
      };

      const send = (message: SessionServerMessage): boolean => {
        if (closed || socket.readyState !== WS_OPEN) return false;
        if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
          reject(CLOSE_POLICY, 'backpressure');
          return false;
        }
        socket.send(JSON.stringify(message));
        return true;
      };

      const sendErrorAndClose = (message: string): void => {
        send({ type: 'error', message });
        reject(CLOSE_POLICY, 'policy violation');
      };

      deadline = setTimeout(() => {
        if (!authenticated) reject(CLOSE_POLICY, 'hello timeout');
      }, HELLO_DEADLINE_MS);
      deadline.unref?.();

      const handleCommand = async (frame: Record<string, unknown>): Promise<void> => {
        if (!sessions || !userId || !device) return;
        const now = Date.now();
        commandTimes = commandTimes.filter((at) => now - at < 1_000);
        if (commandTimes.length >= MAX_COMMANDS_PER_SECOND) {
          sendErrorAndClose('rate-limited');
          return;
        }
        commandTimes.push(now);

        const id =
          typeof frame['id'] === 'string' && frame['id'].length <= MAX_ID_LEN ? frame['id'] : '';
        if (!id) {
          send({ type: 'ack', id: '', ok: false, error: 'invalid-command' });
          return;
        }
        const result: CommandResult = await sessions.command(
          userId,
          device.id,
          frame['command'] as SessionCommand,
        );
        send({
          type: 'ack',
          id,
          ok: result.ok,
          ...(result.error !== undefined ? { error: result.error } : {}),
          ...(result.revision !== undefined ? { revision: result.revision } : {}),
        });
      };

      const handleHello = async (frame: Record<string, unknown>): Promise<void> => {
        const hello = readHello(frame);
        if (!hello) {
          reject(CLOSE_POLICY, 'hello required');
          return;
        }
        releasePreHello();
        if (!verifyToken || !sessions) {
          reject(CLOSE_REFUSED, 'sessions disabled');
          return;
        }
        const verified = await verifyToken(hello.token);
        if (!verified || verified.kind === 'static' || !verified.userId) {
          // The verifier rejects expired tokens as null; peeking at the
          // (untrusted) payload still lets the client distinguish "refresh and
          // reconnect" (4401) from "refused" (4403). It never authenticates.
          const exp = unverifiedExpiry(hello.token);
          if (exp !== undefined && exp <= Math.floor(Date.now() / 1000)) {
            reject(CLOSE_EXPIRED, 'token expired');
          } else {
            reject(CLOSE_REFUSED, 'account required');
          }
          return;
        }
        if (verified.exp !== undefined && verified.exp <= Math.floor(Date.now() / 1000)) {
          reject(CLOSE_EXPIRED, 'token expired');
          return;
        }
        const pendingForUser = authByUser.get(verified.userId) ?? 0;
        if (pendingForUser >= MAX_AUTH_SOCKETS_PER_USER) {
          reject(CLOSE_REFUSED, 'too many connections');
          return;
        }

        userId = verified.userId;
        authByUser.set(userId, pendingForUser + 1);
        authHeld = true;
        device = hello.device;

        connection = {
          id: randomUUID(),
          clientId: device.id,
          send,
          close: () => {
            if (socket.readyState === WS_OPEN) socket.close(1000, 'replaced');
          },
        };
        const conn = connection;
        try {
          const snapshot = sessions.join(userId, conn, device);
          authenticated = true;
          lastActivity = Date.now();
          if (deadline) clearTimeout(deadline);
          deadline = null;
          send({ type: 'welcome', ...snapshot });
        } catch (error) {
          if (error instanceof Error && error.message === 'invalid-device') {
            reject(CLOSE_REFUSED, 'invalid device');
          } else {
            reject(CLOSE_INTERNAL, 'join failed');
          }
          return;
        }

        if (verified.exp !== undefined) {
          const delayMs = verified.exp * 1000 - Date.now();
          expiryTimer = setTimeout(
            () => reject(CLOSE_EXPIRED, 'token expired'),
            Math.min(Math.max(delayMs, 0), 2 ** 31 - 1),
          );
          expiryTimer.unref?.();
        }

        pingTimer = setInterval(() => {
          if (closed) return;
          const now = Date.now();
          if (now - lastActivity >= WS_SILENCE_CLOSE_MS) {
            reject(CLOSE_POLICY, 'idle');
            return;
          }
          if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
            reject(CLOSE_POLICY, 'backpressure');
            return;
          }
          send({ type: 'ping', t0: now });
        }, WS_PING_MS);
        pingTimer.unref?.();
      };

      const handleMessage = async (data: unknown): Promise<void> => {
        if (closed) return;
        lastActivity = Date.now();

        if (!authenticated) {
          // The first frame is `hello` and is size-checked before parsing.
          if (frameBytes(data) > PRE_HELLO_MAX_BYTES) {
            reject(CLOSE_POLICY, 'hello too large');
            return;
          }
          const frame = parseFrame(data);
          if (!frame) {
            reject(CLOSE_POLICY, 'invalid frame');
            return;
          }
          if (frame['type'] !== 'hello') {
            reject(CLOSE_POLICY, 'hello required');
            return;
          }
          await handleHello(frame);
          return;
        }

        const frame = parseFrame(data);
        if (!frame) {
          sendErrorAndClose('invalid frame');
          return;
        }
        const type = frame['type'];
        if (type === 'command') {
          await handleCommand(frame);
          return;
        }
        if (type === 'report') {
          if (sessions && userId && device) {
            sessions.report(userId, device.id, frame as unknown as SessionReportMessage);
          }
          return;
        }
        if (type === 'pong') {
          // Presence refresh: there is no separate pong method.
          if (sessions && userId && device) sessions.touch(userId, device.id, device);
          return;
        }
        sendErrorAndClose('unknown frame');
      };

      let chain: Promise<void> = Promise.resolve();
      socket.on('message', (data: unknown) => {
        chain = chain
          .then(() => handleMessage(data))
          .catch(() => reject(CLOSE_INTERNAL, 'internal error'));
      });
      socket.on('close', () => {
        closed = true;
        cleanup();
      });
      socket.on('error', () => {
        closed = true;
        cleanup();
      });
    },
  );

  // -------------------------------------------------------------------------
  // REST polling routes (native transport).
  // -------------------------------------------------------------------------

  app.get<{ Querystring: StateQuery }>(
    '/session/state',
    {
      schema: {
        querystring: {
          type: 'object',
          required: ['clientId', 'deviceId', 'name', 'platform', 'cast', 'localFiles'],
          properties: {
            clientId: { type: 'string', minLength: 1, maxLength: MAX_ID_LEN },
            deviceId: { type: 'string', minLength: 1, maxLength: MAX_ID_LEN },
            name: { type: 'string', minLength: 1, maxLength: MAX_DEVICE_NAME_LEN },
            platform: { type: 'string', enum: [...PLATFORMS] },
            cast: { type: 'string', enum: ['0', '1'] },
            localFiles: { type: 'string', enum: ['0', '1'] },
            since: { type: 'integer', minimum: 0 },
          },
        },
      },
      preHandler: [
        requireAccount,
        async (request, reply) =>
          requireDeviceHeader(request, reply, request.query.clientId),
      ],
      config: {
        rateLimit: { max: 240, timeWindow: '1 minute', keyGenerator: sessionRateLimitKey },
      },
    },
    async (request, reply) => {
      if (!sessions) return sessionsDisabled(reply);
      const query = request.query;
      const device: SessionDevice = {
        id: query.clientId,
        deviceId: query.deviceId,
        name: query.name,
        platform: query.platform,
        online: true,
        lastSeenAt: Date.now(),
        capabilities: { cast: query.cast === '1', localFiles: query.localFiles === '1' },
      };
      const snapshot = sessions.touch(request.userId ?? '', query.clientId, device);
      if (
        query.since !== undefined &&
        snapshot.session &&
        query.since === snapshot.session.revision
      ) {
        return reply.send(unchangedFrom(snapshot, snapshot.session));
      }
      return reply.send(snapshot);
    },
  );

  app.post<{ Body: CommandBody }>(
    '/session/command',
    {
      bodyLimit: REST_BODY_LIMIT_BYTES,
      schema: {
        body: {
          type: 'object',
          required: ['clientId', 'command'],
          properties: {
            clientId: { type: 'string', minLength: 1, maxLength: MAX_ID_LEN },
            id: { type: 'string', minLength: 1, maxLength: MAX_ID_LEN },
            command: { type: 'object' },
          },
        },
      },
      preHandler: [
        requireAccount,
        async (request, reply) =>
          requireDeviceHeader(request, reply, request.body.clientId),
      ],
      config: {
        rateLimit: { max: 120, timeWindow: '1 minute', keyGenerator: sessionRateLimitKey },
      },
    },
    async (request, reply) => {
      if (!sessions) return sessionsDisabled(reply);
      return reply.send(
        await sessions.command(
          request.userId ?? '',
          request.body.clientId,
          request.body.command,
        ),
      );
    },
  );

  app.post<{ Body: ReportBody }>(
    '/session/report',
    {
      schema: {
        body: {
          type: 'object',
          required: ['clientId', 'reason', 'entryId', 'positionSec', 'playing'],
          properties: {
            clientId: { type: 'string', minLength: 1, maxLength: MAX_ID_LEN },
            reason: { type: 'string', enum: ['tick', 'playing', 'ended', 'native-skip'] },
            entryId: { type: 'string', minLength: 1, maxLength: MAX_ID_LEN },
            positionSec: { type: 'number', minimum: 0 },
            playing: { type: 'boolean' },
            durationSec: { type: 'number', minimum: 0 },
          },
        },
      },
      preHandler: [
        requireAccount,
        async (request, reply) =>
          requireDeviceHeader(request, reply, request.body.clientId),
      ],
      config: {
        rateLimit: { max: 120, timeWindow: '1 minute', keyGenerator: sessionRateLimitKey },
      },
    },
    async (request, reply) => {
      if (!sessions) return sessionsDisabled(reply);
      const body = request.body;
      sessions.report(request.userId ?? '', body.clientId, {
        type: 'report',
        reason: body.reason,
        entryId: body.entryId,
        positionSec: body.positionSec,
        playing: body.playing,
        ...(body.durationSec !== undefined ? { durationSec: body.durationSec } : {}),
      });
      return reply.code(204).send();
    },
  );
};

