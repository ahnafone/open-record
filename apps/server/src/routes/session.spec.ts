import {
  type SessionDevice,
  type SessionReportMessage,
  type SessionServerMessage,
  type SessionSnapshot,
  type SessionTrack,
  type SessionUnchanged,
} from '@open-record/models';
import type { FastifyInstance } from 'fastify';
import { SignJWT } from 'jose';
import { buildApp } from '../app';
import { loadConfig } from '../config';

const TOKEN = 'test-token-0123456789abcdef';
const SECRET = 'super-secret-jwt-token-with-at-least-32-characters';

type WsSocket = Awaited<ReturnType<FastifyInstance['injectWS']>>;

interface WsClient {
  ws: WsSocket;
  messages: SessionServerMessage[];
  closed: Promise<{ code: number; reason: string }>;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const sign = (sub = 'user-1'): Promise<string> =>
  new SignJWT({ role: 'authenticated' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(sub)
    .setAudience('authenticated')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(SECRET));

function device(clientId: string, deviceId = `device-${clientId}`): SessionDevice {
  return {
    id: clientId,
    deviceId,
    name: `Device ${clientId}`,
    platform: 'web',
    online: true,
    lastSeenAt: Date.now(),
    capabilities: { cast: false, localFiles: false },
  };
}

function headers(token: string, clientId: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, 'x-device-id': clientId };
}

function stateUrl(
  clientId: string,
  opts: { deviceId?: string; since?: number; token?: string } = {},
): string {
  const params = new URLSearchParams({
    clientId,
    deviceId: opts.deviceId ?? `device-${clientId}`,
    name: `Device ${clientId}`,
    platform: 'web',
    cast: '0',
    localFiles: '0',
  });
  if (opts.since !== undefined) params.set('since', String(opts.since));
  if (opts.token !== undefined) params.set('token', opts.token);
  return `/session/state?${params.toString()}`;
}

function track(ws: WsSocket): WsClient {
  const messages: SessionServerMessage[] = [];
  let resolveClosed: (value: { code: number; reason: string }) => void = () => undefined;
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    resolveClosed = resolve;
  });
  ws.on('message', (data: unknown) => {
    const text =
      typeof data === 'string'
        ? data
        : Buffer.isBuffer(data)
          ? data.toString('utf8')
          : Buffer.from(data as ArrayBuffer).toString('utf8');
    try {
      messages.push(JSON.parse(text) as SessionServerMessage);
    } catch {
      // A malformed frame is the route's problem, not the test's.
    }
  });
  ws.on('close', (code: number, reason: unknown) => {
    resolveClosed({ code, reason: String(reason) });
  });
  return { ws, messages, closed };
}

async function waitFor<T extends SessionServerMessage = SessionServerMessage>(
  client: WsClient,
  predicate: (message: SessionServerMessage) => boolean,
  timeoutMs = 3_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = client.messages.find(predicate);
    if (found) return found as T;
    await sleep(5);
  }
  throw new Error(`timed out; received: ${JSON.stringify(client.messages)}`);
}

async function expectClose(client: WsClient, code: number): Promise<void> {
  const result = await Promise.race([
    client.closed,
    sleep(3_000).then(() => {
      throw new Error('socket did not close');
    }),
  ]);
  expect(result.code).toBe(code);
}

const trackFor = (entryId: string, title: string): SessionTrack => ({
  entryId,
  id: `track-${entryId}`,
  providerId: 'youtube',
  title,
  artist: 'Artist',
  durationSec: 200,
});

describe('session routes', () => {
  const apps: FastifyInstance[] = [];
  const clients: WsClient[] = [];

  const makeApp = async (env: Record<string, string> = {}): Promise<FastifyInstance> => {
    const app = await buildApp(
      loadConfig({ OPEN_RECORD_TOKEN: TOKEN, SUPABASE_JWT_SECRET: SECRET, ...env }),
    );
    apps.push(app);
    // injectWS routes through Fastify directly; prepare hooks/routes first.
    await app.ready();
    return app;
  };

  const rawClient = async (app: FastifyInstance): Promise<WsClient> => {
    const ws = await app.injectWS('/session');
    const client = track(ws);
    clients.push(client);
    return client;
  };

  const openClient = async (
    app: FastifyInstance,
    token: string,
    clientId: string,
    deviceId = `device-${clientId}`,
  ): Promise<{ client: WsClient; welcome: Extract<SessionServerMessage, { type: 'welcome' }> }> => {
    const client = await rawClient(app);
    client.ws.send(
      JSON.stringify({ type: 'hello', token, device: device(clientId, deviceId) }),
    );
    const welcome = await waitFor<Extract<SessionServerMessage, { type: 'welcome' }>>(
      client,
      (message) => message.type === 'welcome',
    );
    return { client, welcome };
  };

  const getState = (
    app: FastifyInstance,
    token: string,
    clientId: string,
    opts: { deviceId?: string; since?: number; token?: string } = {},
  ) =>
    app.inject({
      method: 'GET',
      url: stateUrl(clientId, opts),
      headers: headers(token, clientId),
    });

  const command = (
    app: FastifyInstance,
    token: string,
    clientId: string,
    payload: Record<string, unknown>,
    header = clientId,
  ) =>
    app.inject({
      method: 'POST',
      url: '/session/command',
      headers: headers(token, header),
      payload,
    });

  const report = (
    app: FastifyInstance,
    token: string,
    clientId: string,
    payload: Omit<SessionReportMessage, 'type'>,
    header = clientId,
  ) =>
    app.inject({
      method: 'POST',
      url: '/session/report',
      headers: headers(token, header),
      payload: { clientId, ...payload },
    });

  afterEach(async () => {
    for (const client of clients.splice(0)) {
      try {
        client.ws.terminate();
      } catch {
        // Already closed by the server.
      }
    }
    for (const app of apps.splice(0)) await app.close();
  });

  it('lets two websocket clients transfer playback and acknowledge commands', async () => {
    const app = await makeApp();
    const token = await sign('ws-user');
    const a = await openClient(app, token, 'ws-a');
    const b = await openClient(app, token, 'ws-b');

    a.client.ws.send(
      JSON.stringify({
        type: 'command',
        id: 'transfer-1',
        command: {
          type: 'transfer',
          target: { kind: 'device', clientId: 'ws-b', deviceId: 'device-ws-b' },
        },
      }),
    );
    const ack = await waitFor<Extract<SessionServerMessage, { type: 'ack' }>>(
      a.client,
      (message) => message.type === 'ack' && message.id === 'transfer-1',
    );
    expect(ack.ok).toBe(true);
    expect(ack.revision).toBeTypeOf('number');

    const revision = ack.revision;
    const stateA = await waitFor<Extract<SessionServerMessage, { type: 'state' }>>(
      a.client,
      (message) => message.type === 'state' && message.session.revision === revision,
    );
    const stateB = await waitFor<Extract<SessionServerMessage, { type: 'state' }>>(
      b.client,
      (message) => message.type === 'state' && message.session.revision === revision,
    );
    expect(stateA.session.target).toEqual({
      kind: 'device',
      clientId: 'ws-b',
      deviceId: 'device-ws-b',
    });
    expect(stateB.session.target).toEqual(stateA.session.target);

    // The newly targeted client can command the room; both sides see the result.
    b.client.ws.send(JSON.stringify({ type: 'command', id: 'pause-1', command: { type: 'pause' } }));
    const ack2 = await waitFor<Extract<SessionServerMessage, { type: 'ack' }>>(
      b.client,
      (message) => message.type === 'ack' && message.id === 'pause-1',
    );
    expect(ack2.ok).toBe(true);
    expect(ack2.revision).toBeTypeOf('number');

    const pausedForA = await waitFor<Extract<SessionServerMessage, { type: 'state' }>>(
      a.client,
      (message) => message.type === 'state' && message.session.revision === ack2.revision,
    );
    const pausedForB = await waitFor<Extract<SessionServerMessage, { type: 'state' }>>(
      b.client,
      (message) => message.type === 'state' && message.session.revision === ack2.revision,
    );
    expect(pausedForA.session.playing).toBe(false);
    expect(pausedForB.session.playing).toBe(false);
  });

  it('supports a polling client: join, command, report, then a fresh poll', async () => {
    const app = await makeApp();
    const token = await sign('poll-user');

    const joined = await getState(app, token, 'poll-1');
    expect(joined.statusCode).toBe(200);
    const snapshot = joined.json() as SessionSnapshot;
    expect(snapshot.devices.map((row) => row.id)).toContain('poll-1');

    const first = trackFor('entry-1', 'First');
    const second = trackFor('entry-2', 'Second');
    const queued = await command(app, token, 'poll-1', {
      clientId: 'poll-1',
      id: 'set-1',
      command: {
        type: 'setQueue',
        order: [first, second],
        cursor: 0,
        autoplay: true,
        shuffle: false,
      },
    });
    expect(queued.statusCode).toBe(200);
    expect(queued.json()).toMatchObject({ ok: true });

    const transferred = await command(app, token, 'poll-1', {
      clientId: 'poll-1',
      id: 'transfer-1',
      command: {
        type: 'transfer',
        target: { kind: 'device', clientId: 'poll-1', deviceId: 'device-poll-1' },
      },
    });
    expect(transferred.json()).toMatchObject({ ok: true });

    const tick = await report(app, token, 'poll-1', {
      reason: 'tick',
      entryId: first.entryId,
      positionSec: 42,
      playing: true,
    });
    expect(tick.statusCode).toBe(204);

    const afterTick = (await getState(app, token, 'poll-1')).json() as SessionSnapshot;
    expect(afterTick.session?.positionSec).toBe(42);

    const ended = await report(app, token, 'poll-1', {
      reason: 'ended',
      entryId: first.entryId,
      positionSec: 42,
      playing: true,
      durationSec: 200,
    });
    expect(ended.statusCode).toBe(204);

    const afterEnded = (await getState(app, token, 'poll-1')).json() as SessionSnapshot;
    expect(afterEnded.session?.cursor).toBe(1);
    expect(afterEnded.session?.positionSec).toBe(0);
    expect(afterEnded.session?.playing).toBe(true);
  });

  it('keeps two clients that share a deviceId as separate rows', async () => {
    const app = await makeApp();
    const token = await sign('shared-device-user');

    expect((await getState(app, token, 'tab-1', { deviceId: 'shared' })).statusCode).toBe(200);
    expect((await getState(app, token, 'tab-2', { deviceId: 'shared' })).statusCode).toBe(200);

    const snapshot = (await getState(app, token, 'tab-1', { deviceId: 'shared' })).json() as
      SessionSnapshot;
    const rows = snapshot.devices.filter((row) => row.deviceId === 'shared');
    expect(rows.map((row) => row.id).sort()).toEqual(['tab-1', 'tab-2']);
  });

  it('short-circuits unchanged polls without the queue but with fresh devices', async () => {
    const app = await makeApp();
    const token = await sign('unchanged-user');

    const initial = (await getState(app, token, 'poll-a')).json() as SessionSnapshot;
    const revision = initial.session?.revision;
    expect(revision).toBeTypeOf('number');
    expect(revision).toBeDefined();
    if (revision === undefined) return;

    const unchangedRes = await getState(app, token, 'poll-a', { since: revision });
    expect(unchangedRes.statusCode).toBe(200);
    const unchanged = unchangedRes.json() as SessionUnchanged;
    expect(unchanged.unchanged).toBe(true);
    expect(unchanged).not.toHaveProperty('order');
    expect(unchanged.devices.map((row) => row.id)).toContain('poll-a');

    // A new device joining does not bump the session revision, but must appear.
    expect((await getState(app, token, 'poll-b')).statusCode).toBe(200);
    const afterJoin = (await getState(app, token, 'poll-a', { since: revision })).json() as
      SessionUnchanged;
    expect(afterJoin.unchanged).toBe(true);
    expect(afterJoin.devices.map((row) => row.id)).toEqual(
      expect.arrayContaining(['poll-a', 'poll-b']),
    );
  });

  it('refuses the static token on all three REST routes', async () => {
    const app = await makeApp();

    expect((await getState(app, TOKEN, 'static-1')).statusCode).toBe(403);
    const commandRes = await command(app, TOKEN, 'static-1', {
      clientId: 'static-1',
      command: { type: 'play' },
    });
    expect(commandRes.statusCode).toBe(403);
    const reportRes = await report(app, TOKEN, 'static-1', {
      reason: 'tick',
      entryId: 'entry-1',
      positionSec: 0,
      playing: false,
    });
    expect(reportRes.statusCode).toBe(403);
  });

  it('returns 503 after auth when SESSION_ENABLED=false', async () => {
    const app = await makeApp({ SESSION_ENABLED: 'false' });
    const token = await sign('disabled-user');

    const stateRes = await getState(app, token, 'off-1');
    expect(stateRes.statusCode).toBe(503);
    expect(stateRes.json()).toEqual({ error: 'sessions-disabled' });

    const commandRes = await command(app, token, 'off-1', {
      clientId: 'off-1',
      command: { type: 'play' },
    });
    expect(commandRes.statusCode).toBe(503);
    expect(commandRes.json()).toEqual({ error: 'sessions-disabled' });

    const reportRes = await report(app, token, 'off-1', {
      reason: 'tick',
      entryId: 'entry-1',
      positionSec: 0,
      playing: false,
    });
    expect(reportRes.statusCode).toBe(503);
    expect(reportRes.json()).toEqual({ error: 'sessions-disabled' });

    // The WS route still completes the hello handshake before refusing.
    const client = await rawClient(app);
    client.ws.send(JSON.stringify({ type: 'hello', token, device: device('off-1') }));
    await expectClose(client, 4403);
  });

  it('requires a matching X-Device-Id header and ignores query tokens', async () => {
    const app = await makeApp();
    const token = await sign('header-user');

    const missing = await app.inject({
      method: 'GET',
      url: stateUrl('header-1'),
      headers: { authorization: `Bearer ${token}` },
    });
    expect(missing.statusCode).toBe(400);

    const mismatched = await app.inject({
      method: 'GET',
      url: stateUrl('header-1'),
      headers: headers(token, 'other-client'),
    });
    expect(mismatched.statusCode).toBe(400);

    const commandRes = await command(
      app,
      token,
      'header-1',
      { clientId: 'header-1', id: 'c1', command: { type: 'play' } },
      'other-client',
    );
    expect(commandRes.statusCode).toBe(400);

    const queryToken = await app.inject({
      method: 'GET',
      url: stateUrl('header-1', { token }),
    });
    expect(queryToken.statusCode).toBe(401);

    const malformed = await command(app, token, 'header-1', { clientId: 'header-1' });
    expect(malformed.statusCode).toBe(400);
  });

  it('closes websocket hellos with a static or invalid token using 4403', async () => {
    const app = await makeApp();
    const jwt = await sign('ws-auth-user');

    const badToken = await rawClient(app);
    badToken.ws.send(JSON.stringify({ type: 'hello', token: 'not-a-token', device: device('bad') }));
    await expectClose(badToken, 4403);

    const staticToken = await rawClient(app);
    staticToken.ws.send(JSON.stringify({ type: 'hello', token: TOKEN, device: device('stat') }));
    await expectClose(staticToken, 4403);

    // A good token still connects on the same app.
    const ok = await openClient(app, jwt, 'good');
    expect(ok.welcome.clientId).toBe('good');
  });

  it('closes an already-expired signed JWT with 4401', async () => {
    const app = await makeApp();
    const nowSec = Math.floor(Date.now() / 1000);
    const expired = await new SignJWT({ role: 'authenticated' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('expired-user')
      .setAudience('authenticated')
      .setIssuedAt(nowSec - 120)
      .setExpirationTime(nowSec - 60)
      .sign(new TextEncoder().encode(SECRET));

    const client = await rawClient(app);
    client.ws.send(JSON.stringify({ type: 'hello', token: expired, device: device('expired') }));
    await expectClose(client, 4401);
  });

  it('validates the websocket first frame', async () => {
    const app = await makeApp();

    const wrongType = await rawClient(app);
    wrongType.ws.send(JSON.stringify({ type: 'pong', t0: 1 }));
    await expectClose(wrongType, 1008);

    const oversized = await rawClient(app);
    oversized.ws.send(
      JSON.stringify({ type: 'hello', token: 'x'.repeat(9_000), device: device('large') }),
    );
    await expectClose(oversized, 1008);

    const token = await sign('frame-user');
    const ok = await openClient(app, token, 'frame-ok');
    expect(ok.welcome.devices.map((row) => row.id)).toContain('frame-ok');
  });
});
