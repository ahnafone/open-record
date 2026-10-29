import type { SessionDevice, SessionServerMessage } from '@open-record/models';
import {
  NativeSession,
  SESSION_ACK_TIMEOUT_MS,
  SessionHttp,
  WebSession,
  createCastUploads,
  createSessionPort,
  sessionWebSocketUrl,
} from './server-session';

const profile: SessionDevice = {
  id: 'c1',
  deviceId: 'd1',
  name: 'Laptop',
  platform: 'web',
  online: true,
  lastSeenAt: 0,
  capabilities: { cast: true, localFiles: true },
};

function fakeResponse(status: number, body: unknown): Response {
  return {
    status,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  } as Response;
}

const base = {
  baseUrl: () => 'http://192.168.1.5:8787',
  refreshAccessToken: async () => null,
};

class FakeSocket {
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }

  message(value: unknown): void {
    this.onmessage?.({ data: JSON.stringify(value) } as MessageEvent);
  }

  serverClose(code: number): void {
    this.readyState = 3;
    const handler = this.onclose;
    this.onclose = null;
    handler?.({ code } as CloseEvent);
  }
}

function lastSent(socket: FakeSocket): unknown {
  return JSON.parse(socket.sent[socket.sent.length - 1] ?? 'null');
}

describe('session transport URLs and platform selection', () => {
  it('maps http(s) to ws(s) and keeps a server path prefix', () => {
    expect(sessionWebSocketUrl('http://192.168.1.5:8787')).toBe(
      'ws://192.168.1.5:8787/session',
    );
    expect(sessionWebSocketUrl('https://tunnel.example.org/base/')).toBe(
      'wss://tunnel.example.org/base/session',
    );
  });

  it('picks polling on native and the WebSocket on the web', () => {
    expect(createSessionPort({ ...base, native: true })).toBeInstanceOf(
      NativeSession,
    );
    expect(createSessionPort({ ...base, native: false })).toBeInstanceOf(
      WebSession,
    );
  });
});

describe('WebSession', () => {
  beforeEach(() => {
    FakeSocket.instances = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends hello on open, answers ping, resolves acks and forwards messages', async () => {
    const session = new WebSession({
      ...base,
      webSocket: FakeSocket as unknown as typeof WebSocket,
      random: () => 0.5,
    });
    const states: string[] = [];
    const messages: SessionServerMessage[] = [];
    session.onChange((state) => states.push(state));
    session.onMessage((message) => messages.push(message));

    const disconnect = session.connect(profile, async () => 'token-1');
    const socket = FakeSocket.instances[0];
    expect(socket.url).toBe('ws://192.168.1.5:8787/session');

    socket.open();
    await Promise.resolve();
    expect(lastSent(socket)).toEqual({
      type: 'hello',
      token: 'token-1',
      device: profile,
    });

    socket.message({
      type: 'welcome',
      serverTime: 1_000,
      clientId: 'c1',
      deviceId: 'd1',
      devicesRevision: 1,
      session: null,
      devices: [],
    });
    expect(session.connection()).toBe('open');

    socket.message({ type: 'ping', t0: 42 });
    expect(lastSent(socket)).toEqual({ type: 'pong', t0: 42 });

    const result = session.command('cmd-1', { type: 'play' });
    expect(lastSent(socket)).toEqual({
      type: 'command',
      id: 'cmd-1',
      command: { type: 'play' },
    });
    socket.message({ type: 'ack', id: 'cmd-1', ok: true, revision: 4 });
    await expect(result).resolves.toEqual({ ok: true, revision: 4 });

    expect(messages.map((message) => message.type)).toEqual([
      'welcome',
      'ack',
    ]);
    // `onChange` also emits the current state on subscribe.
    expect(states).toEqual(['off', 'connecting', 'open']);

    disconnect();
    expect(session.connection()).toBe('off');
    expect(states).toEqual(['off', 'connecting', 'open', 'off']);
  });

  it('resolves a missing ack after the timeout instead of hanging', async () => {
    vi.useFakeTimers();
    const session = new WebSession({
      ...base,
      webSocket: FakeSocket as unknown as typeof WebSocket,
      random: () => 0.5,
    });
    const disconnect = session.connect(profile, async () => 'token');
    const socket = FakeSocket.instances[0];
    socket.open();
    await Promise.resolve();
    socket.message({
      type: 'welcome',
      serverTime: 1_000,
      clientId: 'c1',
      deviceId: 'd1',
      devicesRevision: 1,
      session: null,
      devices: [],
    });

    const result = session.command('cmd-timeout', { type: 'pause' });
    await vi.advanceTimersByTimeAsync(SESSION_ACK_TIMEOUT_MS);
    await expect(result).resolves.toEqual({ ok: false, error: 'timeout' });
    disconnect();
  });

  it('stops after 4403 and never retries', async () => {
    vi.useFakeTimers();
    const session = new WebSession({
      ...base,
      webSocket: FakeSocket as unknown as typeof WebSocket,
      random: () => 0.5,
    });
    const disconnect = session.connect(profile, async () => 'token');
    const socket = FakeSocket.instances[0];
    socket.open();
    await Promise.resolve();
    socket.serverClose(4403);
    expect(session.connection()).toBe('refused');

    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
    disconnect();
  });

  it('refreshes on 4401 and reconnects with the fresh token', async () => {
    vi.useFakeTimers();
    const refresh = vi.fn(async () => 'fresh-token');
    const session = new WebSession({
      ...base,
      refreshAccessToken: refresh,
      webSocket: FakeSocket as unknown as typeof WebSocket,
      random: () => 0.5,
    });
    const disconnect = session.connect(profile, async () => 'old-token');
    const first = FakeSocket.instances[0];
    first.open();
    await Promise.resolve();
    first.serverClose(4401);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(FakeSocket.instances).toHaveLength(2);
    const second = FakeSocket.instances[1];
    second.open();
    await Promise.resolve();
    expect(lastSent(second)).toEqual({
      type: 'hello',
      token: 'fresh-token',
      device: profile,
    });
    disconnect();
  });
});

describe('NativeSession polling', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('polls with since, emits welcome once, then devices and a tick', async () => {
    vi.useFakeTimers();
    const urls: string[] = [];
    const headers: Record<string, string>[] = [];
    const responses: unknown[] = [
      {
        serverTime: 1_000,
        clientId: 'c1',
        deviceId: 'd1',
        devicesRevision: 1,
        session: {
          revision: 3,
          target: null,
          order: [],
          cursor: -1,
          positionSec: 0,
          playing: false,
          shuffle: false,
          repeat: 'off',
          updatedAt: 1_000,
          updatedBy: null,
        },
        devices: [profile],
      },
      {
        unchanged: true,
        revision: 3,
        devicesRevision: 2,
        serverTime: 2_000,
        positionSec: 7,
        playing: false,
        updatedAt: 1_500,
        devices: [profile],
      },
    ];
    const fetchImpl = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        urls.push(String(input));
        headers.push((init?.headers ?? {}) as Record<string, string>);
        return fakeResponse(200, responses.shift());
      },
    ) as unknown as typeof fetch;

    const session = new NativeSession({
      ...base,
      native: false,
      fetchImpl,
      now: () => 1_000,
    });
    const messages: SessionServerMessage[] = [];
    session.onMessage((message) => messages.push(message));
    const disconnect = session.connect(profile, async () => 'jwt');

    await vi.advanceTimersByTimeAsync(0);
    expect(urls).toHaveLength(1);
    const firstUrl = new URL(urls[0]);
    expect(firstUrl.pathname).toBe('/session/state');
    expect(firstUrl.searchParams.get('clientId')).toBe('c1');
    expect(firstUrl.searchParams.get('deviceId')).toBe('d1');
    expect(firstUrl.searchParams.get('platform')).toBe('web');
    expect(firstUrl.searchParams.get('cast')).toBe('1');
    expect(firstUrl.searchParams.get('localFiles')).toBe('1');
    expect(firstUrl.searchParams.has('since')).toBe(false);
    expect(headers[0]['Authorization']).toBe('Bearer jwt');
    expect(headers[0]['X-Device-Id']).toBe('c1');
    expect(messages.map((message) => message.type)).toEqual(['welcome']);
    expect(session.connection()).toBe('open');

    await vi.advanceTimersByTimeAsync(1_000);
    expect(urls).toHaveLength(2);
    expect(new URL(urls[1]).searchParams.get('since')).toBe('3');
    expect(messages.map((message) => message.type)).toEqual([
      'welcome',
      'devices',
      'tick',
    ]);
    const tick = messages[2];
    expect(tick.type === 'tick' && tick.revision).toBe(3);
    expect(tick.type === 'tick' && tick.positionSec).toBe(7);
    expect(session.skewMs()).toBe(1_000);

    disconnect();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(urls).toHaveLength(2);
    expect(session.connection()).toBe('off');
  });
});

describe('SessionHttp', () => {
  it('refreshes once on 401 and retries with the fresh token', async () => {
    const seen: string[] = [];
    const refresh = vi.fn(async () => 'new-token');
    const unauthorized = vi.fn();
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push((init?.headers as Record<string, string>)['Authorization'] ?? '');
      return seen.length === 1 ? fakeResponse(401, { error: 'expired' }) : fakeResponse(200, { ok: true });
    }) as unknown as typeof fetch;

    const http = new SessionHttp({
      baseUrl: () => 'http://host',
      clientId: () => 'c1',
      accessToken: async () => 'old-token',
      refreshAccessToken: refresh,
      native: false,
      fetchImpl,
      onUnauthorized: unauthorized,
    });

    await expect(http.get('session/state')).resolves.toEqual({
      status: 200,
      data: { ok: true },
    });
    expect(seen).toEqual(['Bearer old-token', 'Bearer new-token']);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(unauthorized).not.toHaveBeenCalled();
  });

  it('gives up after a second 401 and tells the caller to stop polling', async () => {
    const seen: string[] = [];
    const refresh = vi.fn(async () => 'new-token');
    const unauthorized = vi.fn();
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push((init?.headers as Record<string, string>)['Authorization'] ?? '');
      return fakeResponse(401, { error: 'expired' });
    }) as unknown as typeof fetch;

    const http = new SessionHttp({
      baseUrl: () => 'http://host',
      clientId: () => 'c1',
      accessToken: async () => 'old-token',
      refreshAccessToken: refresh,
      native: false,
      fetchImpl,
      onUnauthorized: unauthorized,
    });

    await expect(http.get('session/state')).resolves.toEqual({
      status: 401,
      data: { error: 'expired' },
    });
    expect(seen).toHaveLength(2);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(unauthorized).toHaveBeenCalledTimes(1);
  });
});

describe('cast uploads', () => {
  it('rejects with a friendly message on native', async () => {
    const uploads = createCastUploads({
      baseUrl: () => 'http://host',
      accessToken: async () => 'token',
      refreshAccessToken: async () => null,
      native: true,
    });
    await expect(
      uploads.upload(new Blob(['x']), 'cover.mp3'),
    ).rejects.toThrow('only available in the browser');
  });
});
