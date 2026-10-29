import { Capacitor, CapacitorHttp } from '@capacitor/core';
import {
  WS_MAX_PAYLOAD_BYTES,
  joinUrl,
  type CommandResult,
  type SessionClientMessage,
  type SessionCommand,
  type SessionDevice,
  type SessionServerMessage,
  type SessionSnapshot,
  type SessionTarget,
  type SessionUnchanged,
} from '@open-record/models';
import {
  CastUploadPort,
  SessionPort,
  type SessionConnectionState,
} from '@open-record/state';

/**
 * Client session transport (§0.4): a WebSocket on the web, HTTP polling on
 * native. Deliberately independent from `HttpTransport`/`RemoteClient`: this
 * one supports DELETE, abort and per-request timeouts, sends `X-Device-Id`,
 * and refreshes an expired JWT instead of opening the sign-in prompt.
 */

/** Polls must fail fast so the next one can start. */
export const SESSION_POLL_TIMEOUT_MS = 5_000;
/** Commands and reports may carry a queue; give them the longer budget. */
export const SESSION_COMMAND_TIMEOUT_MS = 15_000;
/** A WS command waits this long for its `ack`. */
export const SESSION_ACK_TIMEOUT_MS = 10_000;
/** WS close codes (application range) used by the server. */
const CLOSE_EXPIRED = 4401;
const CLOSE_REFUSED = 4403;
const WS_OPEN = 1;
const WS_CONNECTING = 0;
const NATIVE_POLL_VISIBLE_MS = 1_000;
const NATIVE_POLL_HIDDEN_TARGET_MS = 5_000;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function abortError(): Error {
  return new DOMException('The request was aborted.', 'AbortError');
}

function parseBody(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function normalizeData(data: unknown): unknown {
  return typeof data === 'string' ? parseBody(data) : data;
}

function errorText(data: unknown): string | undefined {
  return isRecord(data) && typeof data['error'] === 'string' ? data['error'] : undefined;
}

function isServerMessage(value: unknown): value is SessionServerMessage {
  if (!isRecord(value)) return false;
  switch (value['type']) {
    case 'welcome':
    case 'state':
    case 'tick':
    case 'devices':
    case 'ack':
    case 'ping':
    case 'error':
      return true;
    default:
      return false;
  }
}

function parseServerMessage(raw: unknown): SessionServerMessage | null {
  if (typeof raw !== 'string') return null;
  const parsed = parseBody(raw);
  return isServerMessage(parsed) ? parsed : null;
}

/**
 * `http(s)://host[/prefix]` → `ws(s)://host[/prefix]/session`. Relative bases
 * resolve against the current page so a same-origin web build works.
 */
export function sessionWebSocketUrl(base: string): string {
  const joined = joinUrl(base, 'session');
  const absolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(joined)
    ? joined
    : new URL(
        joined,
        typeof location !== 'undefined' ? location.href : 'http://localhost/',
      ).href;
  const url = new URL(absolute);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

// ---------------------------------------------------------------------------
// SessionHttp
// ---------------------------------------------------------------------------

export interface SessionHttpOptions {
  baseUrl: () => string;
  /** The `X-Device-Id` header; the session's `clientId`. */
  clientId: () => string;
  accessToken: () => Promise<string | null>;
  refreshAccessToken: () => Promise<string | null>;
  /** CapacitorHttp when true, `fetch` otherwise. Defaults to the platform. */
  native?: boolean;
  /** Test seam; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /**
   * Called when a request is still `401` after one refresh (or when the
   * refresh itself fails): the caller stops polling until the next auth change.
   */
  onUnauthorized?: () => void;
}

export interface SessionHttpResult<T> {
  status: number;
  data: T | undefined;
}

interface RequestOptions {
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * The dedicated HTTP client for session REST calls. JSON only; GET/POST/
 * DELETE; aborts and timeouts; `Authorization` + `X-Device-Id` headers. A
 * `401` triggers one token refresh and one retry; a second `401` (or a failed
 * refresh) calls `onUnauthorized` and returns the `401` response.
 */
export class SessionHttp {
  private readonly native: boolean;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: SessionHttpOptions) {
    this.native = options.native ?? Capacitor.isNativePlatform();
    this.fetchImpl =
      options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  }

  get<T>(
    path: string,
    query?: Record<string, string | number | undefined>,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<SessionHttpResult<T>> {
    return this.request<T>('GET', path, {
      query,
      signal: opts?.signal,
      timeoutMs: opts?.timeoutMs ?? SESSION_POLL_TIMEOUT_MS,
    });
  }

  post<T>(
    path: string,
    body: unknown,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<SessionHttpResult<T>> {
    return this.request<T>('POST', path, {
      body,
      signal: opts?.signal,
      timeoutMs: opts?.timeoutMs ?? SESSION_COMMAND_TIMEOUT_MS,
    });
  }

  delete<T>(
    path: string,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<SessionHttpResult<T>> {
    return this.request<T>('DELETE', path, {
      signal: opts?.signal,
      timeoutMs: opts?.timeoutMs ?? SESSION_COMMAND_TIMEOUT_MS,
    });
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    opts: RequestOptions,
    freshToken?: string,
  ): Promise<SessionHttpResult<T>> {
    let token: string | null;
    if (freshToken !== undefined) token = freshToken;
    else {
      try {
        token = await this.options.accessToken();
      } catch {
        token = null;
      }
    }

    const response = await this.send<T>(method, path, token, opts);
    if (response.status !== 401) return response;

    // One refresh per request. A retried request that is still 401 gives up.
    if (freshToken !== undefined) {
      this.options.onUnauthorized?.();
      return response;
    }
    let refreshed: string | null = null;
    try {
      refreshed = await this.options.refreshAccessToken();
    } catch {
      refreshed = null;
    }
    if (!refreshed) {
      this.options.onUnauthorized?.();
      return response;
    }
    return this.request<T>(method, path, opts, refreshed);
  }

  private async send<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    token: string | null,
    opts: RequestOptions,
  ): Promise<SessionHttpResult<T>> {
    const url = this.url(path, opts.query);
    const headers: Record<string, string> = { accept: 'application/json' };
    const clientId = this.options.clientId().trim();
    if (clientId) headers['X-Device-Id'] = clientId;
    if (token) headers['Authorization'] = `Bearer ${token}`;
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

    const timeoutMs = opts.timeoutMs ?? SESSION_POLL_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const external = opts.signal;
    const onAbort = () => controller.abort();
    if (external?.aborted) controller.abort();
    else external?.addEventListener('abort', onAbort, { once: true });

    try {
      if (this.native)
        return await this.sendNative<T>(url, method, headers, opts.body, controller.signal, timeoutMs);
      return await this.sendFetch<T>(url, method, headers, opts.body, controller.signal);
    } finally {
      clearTimeout(timer);
      external?.removeEventListener('abort', onAbort);
    }
  }

  private async sendFetch<T>(
    url: string,
    method: string,
    headers: Record<string, string>,
    body: unknown,
    signal: AbortSignal,
  ): Promise<SessionHttpResult<T>> {
    const response = await this.fetchImpl(url, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal,
    });
    const text = await response.text();
    return {
      status: response.status,
      data: (text ? parseBody(text) : undefined) as T | undefined,
    };
  }

  private async sendNative<T>(
    url: string,
    method: string,
    headers: Record<string, string>,
    body: unknown,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<SessionHttpResult<T>> {
    if (signal.aborted) throw abortError();
    let response;
    try {
      response = await CapacitorHttp.request({
        url,
        method,
        headers,
        ...(body !== undefined ? { data: body } : {}),
        connectTimeout: timeoutMs,
        readTimeout: timeoutMs,
      });
    } catch (error) {
      if (signal.aborted) throw abortError();
      throw new Error('Could not reach the download server.', { cause: error });
    }
    // CapacitorHttp cannot be aborted mid-flight; honour a timeout after it.
    if (signal.aborted) throw abortError();
    return {
      status: response.status,
      data: normalizeData(response.data) as T | undefined,
    };
  }

  private url(
    path: string,
    query?: Record<string, string | number | undefined>,
  ): string {
    const base = joinUrl(this.options.baseUrl(), path);
    if (!query) return base;
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) params.set(key, String(value));
    }
    const search = params.toString();
    if (!search) return base;
    return `${base}${base.includes('?') ? '&' : '?'}${search}`;
  }
}

// ---------------------------------------------------------------------------
// Session adapter factory
// ---------------------------------------------------------------------------

export interface ServerSessionOptions {
  /** Lazy: settings are assigned after app config is created. */
  baseUrl: () => string;
  /** Used by the cast upload adapter; sessions use `connect`'s token getter. */
  accessToken?: () => Promise<string | null>;
  refreshAccessToken: () => Promise<string | null>;
  /** Overrides platform detection (tests). */
  native?: boolean;
  fetchImpl?: typeof fetch;
  /** Overrides the global WebSocket (tests). */
  webSocket?: typeof WebSocket;
  now?: () => number;
  random?: () => number;
}

export function createSessionPort(options: ServerSessionOptions): SessionPort {
  const native = options.native ?? Capacitor.isNativePlatform();
  return native ? new NativeSession(options) : new WebSession(options);
}

/** Shared port plumbing: connection state and message listeners. */
abstract class BaseSession extends SessionPort {
  private readonly stateListeners = new Set<
    (state: SessionConnectionState) => void
  >();
  private readonly messageListeners = new Set<
    (message: SessionServerMessage) => void
  >();
  protected connectionState: SessionConnectionState = 'off';

  constructor(protected readonly options: ServerSessionOptions) {
    super();
  }

  connection(): SessionConnectionState {
    return this.connectionState;
  }

  onChange(listener: (state: SessionConnectionState) => void): () => void {
    this.stateListeners.add(listener);
    try {
      listener(this.connectionState);
    } catch {
      // A UI listener must not break the transport.
    }
    return () => this.stateListeners.delete(listener);
  }

  onMessage(listener: (message: SessionServerMessage) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  protected setConnection(next: SessionConnectionState): void {
    if (this.connectionState === next) return;
    this.connectionState = next;
    for (const listener of [...this.stateListeners]) {
      try {
        listener(next);
      } catch {
        // Keep notifying the other listeners.
      }
    }
  }

  protected emit(message: SessionServerMessage): void {
    for (const listener of [...this.messageListeners]) {
      try {
        listener(message);
      } catch {
        // A store listener must not break the transport.
      }
    }
  }

  /** A configured download server is part of "sessions can run here". */
  protected hasServer(): boolean {
    try {
      return this.options.baseUrl().trim() !== '';
    } catch {
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// Web: WebSocket
// ---------------------------------------------------------------------------

interface PendingCommand {
  resolve: (result: CommandResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class WebSession extends BaseSession {
  private socket?: WebSocket;
  private token?: () => Promise<string | null>;
  private profile: SessionDevice | null = null;
  private active = false;
  private generation = 0;
  private attempts = 0;
  private retryTimer?: ReturnType<typeof setTimeout>;
  /** A token obtained from the 4401 refresh, used for the next `hello`. */
  private handshakeToken?: string;
  private readonly pending = new Map<string, PendingCommand>();

  available(): boolean {
    if (!this.hasServer()) return false;
    return this.options.webSocket !== undefined || typeof WebSocket !== 'undefined';
  }

  connect(
    profile: SessionDevice,
    token: () => Promise<string | null>,
  ): () => void {
    this.teardown();
    const generation = ++this.generation;
    this.profile = profile;
    this.token = token;
    this.active = true;
    this.attempts = 0;
    this.setConnection('connecting');
    this.installReconnectListeners();
    this.open();
    return () => {
      if (this.generation === generation && this.active) this.finish('off');
    };
  }

  send(message: SessionClientMessage): void {
    if (message.type !== 'report' && message.type !== 'pong') return;
    this.sendFrame(message);
  }

  command(id: string, command: SessionCommand): Promise<CommandResult> {
    const socket = this.socket;
    if (!this.active || !socket || socket.readyState !== WS_OPEN) {
      return Promise.resolve({ ok: false, error: 'offline' });
    }
    const frame = JSON.stringify({ type: 'command', id, command });
    // The server closes an oversized frame without an ack, so refuse it here
    // with a budget for the protocol overhead.
    if (
      new TextEncoder().encode(frame).length >
      WS_MAX_PAYLOAD_BYTES - 1024
    ) {
      return Promise.resolve({ ok: false, error: 'queue-too-large' });
    }
    return new Promise<CommandResult>((resolve) => {
      const previous = this.pending.get(id);
      if (previous) {
        clearTimeout(previous.timer);
        previous.resolve({ ok: false, error: 'superseded' });
      }
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) resolve({ ok: false, error: 'timeout' });
      }, SESSION_ACK_TIMEOUT_MS);
      this.pending.set(id, { resolve, timer });
      try {
        socket.send(frame);
      } catch {
        this.pending.delete(id);
        clearTimeout(timer);
        resolve({ ok: false, error: 'offline' });
      }
    });
  }

  private readonly onOnline = (): void => {
    if (this.connectionState === 'retrying') this.retryNow();
  };

  private readonly onVisibility = (): void => {
    if (this.isVisible() && this.connectionState === 'retrying') this.retryNow();
  };

  private open(): void {
    if (!this.active || !this.profile) return;
    const Ctor =
      this.options.webSocket ??
      (typeof WebSocket === 'undefined' ? undefined : WebSocket);
    if (!Ctor) {
      this.finish('off');
      return;
    }

    this.setConnection('connecting');
    let socket: WebSocket;
    try {
      socket = new Ctor(sessionWebSocketUrl(this.options.baseUrl()));
    } catch {
      this.scheduleRetry();
      return;
    }
    this.socket = socket;
    socket.onopen = () => void this.sendHello(socket);
    socket.onmessage = (event: MessageEvent) => {
      const message = parseServerMessage(event.data);
      if (message) this.handleMessage(socket, message);
    };
    socket.onclose = (event: CloseEvent) => this.handleClose(socket, event.code);
    socket.onerror = () => {
      // A close event follows; reconnect is handled there.
    };
  }

  private async sendHello(socket: WebSocket): Promise<void> {
    if (
      !this.active ||
      this.socket !== socket ||
      socket.readyState !== WS_OPEN ||
      !this.profile
    ) {
      return;
    }
    let token: string | null = this.handshakeToken ?? null;
    this.handshakeToken = undefined;
    if (!token) {
      try {
        token = (await this.token?.()) ?? null;
      } catch {
        token = null;
      }
    }
    if (!this.active || this.socket !== socket || socket.readyState !== WS_OPEN)
      return;
    if (!token) {
      // Nothing to authenticate with; wait for the next connect (sign-in).
      this.finish('off');
      return;
    }
    this.sendFrame({ type: 'hello', token, device: this.profile });
  }

  private handleMessage(socket: WebSocket, message: SessionServerMessage): void {
    if (socket !== this.socket) return;
    switch (message.type) {
      case 'ping':
        this.sendFrame({ type: 'pong', t0: message.t0 });
        return;
      case 'welcome':
        this.attempts = 0;
        this.setConnection('open');
        break;
      case 'ack': {
        const pending = this.pending.get(message.id);
        if (pending) {
          this.pending.delete(message.id);
          clearTimeout(pending.timer);
          pending.resolve({
            ok: message.ok,
            ...(message.error !== undefined ? { error: message.error } : {}),
            ...(message.revision !== undefined
              ? { revision: message.revision }
              : {}),
          });
        }
        break;
      }
      default:
        break;
    }
    this.emit(message);
  }

  private handleClose(socket: WebSocket, code: number): void {
    if (socket !== this.socket) return;
    this.socket = undefined;
    this.rejectPending('disconnected');
    if (!this.active) return;

    if (code === CLOSE_REFUSED) {
      this.finish('refused');
      return;
    }
    if (code === CLOSE_EXPIRED) {
      void this.refreshAndReconnect();
      return;
    }
    this.scheduleRetry();
  }

  private async refreshAndReconnect(): Promise<void> {
    const generation = this.generation;
    this.setConnection('retrying');
    let token: string | null = null;
    try {
      token = await this.options.refreshAccessToken();
    } catch {
      token = null;
    }
    if (!this.active || this.generation !== generation) return;
    if (!token) {
      // No usable credential. Retry slowly so a later refresh (or sign-in)
      // can recover it, without a hot loop against the server.
      this.scheduleRetry();
      return;
    }
    // Send the fresh token with the next hello; otherwise the old token
    // provider could hand the expired one back.
    this.handshakeToken = token;
    // Normal backoff keeps a token the server still rejects from hot-looping.
    this.scheduleRetry();
  }

  private sendFrame(message: SessionClientMessage): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WS_OPEN) return;
    try {
      socket.send(JSON.stringify(message));
    } catch {
      // The close handler reconnects.
    }
  }

  private scheduleRetry(): void {
    if (!this.active || this.retryTimer !== undefined) return;
    this.setConnection('retrying');
    const attempt = Math.min(this.attempts++, 5);
    const backoff = Math.min(
      BACKOFF_MAX_MS,
      BACKOFF_MIN_MS * 2 ** attempt,
    );
    const random = this.options.random ?? Math.random;
    const delay = Math.min(
      BACKOFF_MAX_MS,
      Math.round(backoff * (0.8 + random() * 0.4)),
    );
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.open();
    }, delay);
  }

  private retryNow(): void {
    // No scheduled retry means a connect attempt (or a 4401 refresh) is
    // already in flight; do not start a second one.
    if (!this.active || this.retryTimer === undefined) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    if (this.socket) return;
    this.attempts = 0;
    this.open();
  }

  private finish(state: SessionConnectionState): void {
    this.active = false;
    this.clearRetry();
    this.removeReconnectListeners();
    this.closeSocket();
    this.rejectPending('disconnected');
    this.token = undefined;
    this.handshakeToken = undefined;
    this.profile = null;
    this.setConnection(state);
  }

  /** Silent reset used by `connect` (the new connection owns the state). */
  private teardown(): void {
    this.active = false;
    this.clearRetry();
    this.removeReconnectListeners();
    this.closeSocket();
    this.rejectPending('disconnected');
    this.token = undefined;
    this.handshakeToken = undefined;
    this.profile = null;
  }

  private closeSocket(): void {
    const socket = this.socket;
    this.socket = undefined;
    if (!socket) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    try {
      if (
        socket.readyState === WS_CONNECTING ||
        socket.readyState === WS_OPEN
      ) {
        socket.close(1000, 'disconnect');
      }
    } catch {
      // Already closed.
    }
  }

  private rejectPending(error: string): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, error });
    }
    this.pending.clear();
  }

  private clearRetry(): void {
    if (this.retryTimer === undefined) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  private installReconnectListeners(): void {
    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.onOnline);
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.onVisibility);
    }
  }

  private removeReconnectListeners(): void {
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.onOnline);
    }
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onVisibility);
    }
  }

  private isVisible(): boolean {
    return typeof document === 'undefined' || document.visibilityState === 'visible';
  }
}

// ---------------------------------------------------------------------------
// Native: HTTP polling
// ---------------------------------------------------------------------------

export class NativeSession extends BaseSession {
  private http?: SessionHttp;
  private profile: SessionDevice | null = null;
  private active = false;
  private generation = 0;
  private polling = false;
  private timer?: ReturnType<typeof setTimeout>;
  /** Last session revision the server reported; sent back as `since`. */
  private revision = -1;
  private welcomeSent = false;
  private target: SessionTarget | null = null;
  private playing = false;
  /**
   * `serverTime - Date.now()` from the latest poll. The welcome frame carries
   * `serverTime`, which is what `SessionStore` uses to anchor its clock.
   */
  private skew = 0;

  available(): boolean {
    // Native polling has no WebSocket dependency.
    return this.hasServer();
  }

  connect(
    profile: SessionDevice,
    token: () => Promise<string | null>,
  ): () => void {
    this.teardown();
    const generation = ++this.generation;
    this.profile = profile;
    this.active = true;
    this.revision = -1;
    this.welcomeSent = false;
    this.target = null;
    this.playing = false;
    this.skew = 0;
    const native = this.options.native ?? Capacitor.isNativePlatform();
    this.http = new SessionHttp({
      baseUrl: this.options.baseUrl,
      clientId: () => this.profile?.id ?? '',
      accessToken: token,
      refreshAccessToken: this.options.refreshAccessToken,
      native,
      fetchImpl: this.options.fetchImpl,
      onUnauthorized: () => {
        if (this.generation === generation && this.active) this.halt('off');
      },
    });
    this.setConnection('connecting');
    this.installVisibilityListener();
    this.schedule(0);
    return () => {
      if (this.generation === generation && this.active) this.halt('off');
    };
  }

  send(message: SessionClientMessage): void {
    if (message.type === 'pong') return; // The next poll refreshes presence.
    if (message.type !== 'report') return;
    const http = this.http;
    const profile = this.profile;
    const generation = this.generation;
    if (!this.active || !http || !profile) return;
    const body: Record<string, unknown> = {
      clientId: profile.id,
      reason: message.reason,
      entryId: message.entryId,
      positionSec: message.positionSec,
      playing: message.playing,
    };
    if (message.durationSec !== undefined) body['durationSec'] = message.durationSec;
    void http
      .post('session/report', body, { timeoutMs: SESSION_COMMAND_TIMEOUT_MS })
      .then((response) => {
        if (
          this.active &&
          this.generation === generation &&
          response.status === 403
        ) {
          this.halt('refused');
        }
      })
      .catch(() => {
        // The next poll retries presence; a report is fire-and-forget.
      });
  }

  async command(id: string, command: SessionCommand): Promise<CommandResult> {
    const http = this.http;
    const profile = this.profile;
    const generation = this.generation;
    if (!this.active || !http || !profile) {
      return { ok: false, error: 'offline' };
    }
    try {
      const response = await http.post<CommandResult>(
        'session/command',
        { clientId: profile.id, id, command },
        { timeoutMs: SESSION_COMMAND_TIMEOUT_MS },
      );
      if (!this.active || this.generation !== generation) {
        return { ok: false, error: 'offline' };
      }
      if (response.status === 403) {
        this.halt('refused');
        return { ok: false, error: 'refused' };
      }
      if (response.status === 401) return { ok: false, error: 'unauthorized' };
      if (response.status < 200 || response.status >= 300) {
        return {
          ok: false,
          error: errorText(response.data) ?? `http-${response.status}`,
        };
      }
      const result = response.data;
      if (!isRecord(result) || typeof result['ok'] !== 'boolean') {
        return { ok: false, error: 'invalid-response' };
      }
      return {
        ok: result['ok'],
        ...(typeof result['revision'] === 'number'
          ? { revision: result['revision'] }
          : {}),
        ...(typeof result['error'] === 'string'
          ? { error: result['error'] }
          : {}),
      };
    } catch {
      return { ok: false, error: 'offline' };
    }
  }

  private readonly onVisibility = (): void => {
    if (!this.active) return;
    if (this.isVisible()) {
      this.clearTimer();
      this.schedule(0);
      return;
    }
    // Hiding pauses polling unless this client is the playing target.
    if (!this.isPlayingTarget()) this.clearTimer();
  };

  private async poll(): Promise<void> {
    if (!this.active || this.polling) return;
    const http = this.http;
    const profile = this.profile;
    if (!http || !profile) return;
    const generation = this.generation;

    this.polling = true;
    try {
      const query: Record<string, string | number | undefined> = {
        clientId: profile.id,
        deviceId: profile.deviceId,
        name: profile.name,
        platform: profile.platform,
        cast: profile.capabilities.cast ? '1' : '0',
        localFiles: profile.capabilities.localFiles ? '1' : '0',
      };
      if (this.revision >= 0) query['since'] = this.revision;

      const response = await http.get<SessionSnapshot | SessionUnchanged>(
        'session/state',
        query,
        { timeoutMs: SESSION_POLL_TIMEOUT_MS },
      );
      if (!this.active || this.generation !== generation) return;
      if (response.status === 403) {
        this.halt('refused');
        return;
      }
      if (response.status === 401) {
        // SessionHttp already refreshed once (and called `onUnauthorized` if
        // that failed); do not keep polling with a rejected token.
        this.halt('off');
        return;
      }
      if (
        response.status < 200 ||
        response.status >= 300 ||
        !isRecord(response.data)
      ) {
        this.setConnection('retrying');
        return;
      }
      if (!this.consume(response.data)) {
        this.setConnection('retrying');
        return;
      }
      this.setConnection('open');
    } catch {
      if (this.active && this.generation === generation) {
        this.setConnection('retrying');
      }
    } finally {
      // A newer connection owns `polling` once teardown/reconnect ran.
      if (this.generation === generation) {
        this.polling = false;
        if (this.active) this.scheduleNext();
      }
    }
  }

  /** Latest `serverTime - Date.now()`; exported for diagnostics/tests. */
  skewMs(): number {
    return this.skew;
  }

  private consume(data: Record<string, unknown>): boolean {
    if (typeof data['serverTime'] === 'number') {
      this.skew = data['serverTime'] - (this.options.now?.() ?? Date.now());
    }
    if (data['unchanged'] === true) {
      return this.consumeUnchanged(data as unknown as SessionUnchanged);
    }
    return this.consumeSnapshot(data as unknown as SessionSnapshot);
  }

  private consumeSnapshot(snapshot: SessionSnapshot): boolean {
    if (
      !Array.isArray(snapshot.devices) ||
      typeof snapshot.devicesRevision !== 'number'
    ) {
      return false;
    }
    if (snapshot.session) {
      this.revision = snapshot.session.revision;
      this.target = snapshot.session.target;
      this.playing = snapshot.session.playing;
    } else {
      this.revision = -1;
      this.target = null;
      this.playing = false;
    }

    // The first poll is the native equivalent of `welcome`: it carries the
    // server clock so SessionStore can compute skew, and the full device list.
    if (!this.welcomeSent) {
      this.welcomeSent = true;
      this.emit({ type: 'welcome', ...snapshot });
      return true;
    }

    if (snapshot.session) {
      this.emit({ type: 'state', session: snapshot.session });
    }
    this.emit({
      type: 'devices',
      devices: snapshot.devices,
      devicesRevision: snapshot.devicesRevision,
    });
    return true;
  }

  private consumeUnchanged(data: SessionUnchanged): boolean {
    if (!Array.isArray(data.devices)) return false;
    this.revision = data.revision;
    this.playing = data.playing;
    // Presence changes arrive even when playback did not; the store must see
    // both, and the tick keeps its anchor transport-agnostic.
    this.emit({
      type: 'devices',
      devices: data.devices,
      devicesRevision: data.devicesRevision,
    });
    this.emit({
      type: 'tick',
      revision: data.revision,
      positionSec: data.positionSec,
      playing: data.playing,
      updatedAt: data.updatedAt,
      ...(data.targetStale === true ? { targetStale: true } : {}),
    });
    return true;
  }

  private scheduleNext(): void {
    if (!this.active) return;
    if (!this.isVisible() && !this.isPlayingTarget()) return;
    this.schedule(
      this.isVisible()
        ? NATIVE_POLL_VISIBLE_MS
        : NATIVE_POLL_HIDDEN_TARGET_MS,
    );
  }

  private schedule(delayMs: number): void {
    if (!this.active || this.timer !== undefined || this.polling) return;
    if (!this.isVisible() && !this.isPlayingTarget()) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.poll();
    }, delayMs);
  }

  private clearTimer(): void {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private isPlayingTarget(): boolean {
    const profile = this.profile;
    return (
      !!profile &&
      this.playing &&
      this.target?.kind === 'device' &&
      this.target.clientId === profile.id
    );
  }

  private isVisible(): boolean {
    return (
      typeof document === 'undefined' || document.visibilityState !== 'hidden'
    );
  }

  private halt(state: SessionConnectionState): void {
    this.teardown();
    this.setConnection(state);
  }

  private teardown(): void {
    this.active = false;
    this.polling = false;
    this.clearTimer();
    this.removeVisibilityListener();
    this.http = undefined;
    this.profile = null;
  }

  private installVisibilityListener(): void {
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.onVisibility);
    }
  }

  private removeVisibilityListener(): void {
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onVisibility);
    }
  }
}

// ---------------------------------------------------------------------------
// Cast uploads (web only)
// ---------------------------------------------------------------------------

export interface ServerCastOptions {
  baseUrl: () => string;
  accessToken: () => Promise<string | null>;
  refreshAccessToken: () => Promise<string | null>;
  /** Rate-limit identity for `X-Device-Id`; the install's device id. */
  clientId?: () => string;
  native?: boolean;
  fetchImpl?: typeof fetch;
}

interface UploadResult {
  uploadId: string;
  sizeBytes: number;
  expiresAt: number;
}

/**
 * `CastUploadPort` over `POST /cast/uploads` (multipart, XHR for progress and
 * abort), `GET /cast/uploads/usage` and `DELETE /cast/uploads`. Browser only:
 * a phone cannot cast a local import (and multipart never goes through
 * SessionHttp).
 */
export class ServerCastUploads extends CastUploadPort {
  private readonly native: boolean;
  private readonly http: SessionHttp;

  constructor(private readonly options: ServerCastOptions) {
    super();
    this.native = options.native ?? Capacitor.isNativePlatform();
    this.http = new SessionHttp({
      baseUrl: options.baseUrl,
      clientId: options.clientId ?? (() => 'cast-upload'),
      accessToken: options.accessToken,
      refreshAccessToken: options.refreshAccessToken,
      native: this.native,
      fetchImpl: options.fetchImpl,
    });
  }

  async upload(
    file: Blob,
    name: string,
    opts?: { signal?: AbortSignal; onProgress?: (fraction: number) => void },
  ): Promise<UploadResult> {
    this.ensureSupported();
    if (typeof XMLHttpRequest === 'undefined') {
      throw new Error('Uploading files is not supported here.');
    }
    let token: string | null = null;
    try {
      token = await this.options.accessToken();
    } catch {
      token = null;
    }
    if (!token) throw new Error('Sign in to cast music from this browser.');
    return this.uploadOnce(file, name, token, opts, false);
  }

  async usage(): Promise<{ bytes: number; count: number; cap: number }> {
    this.ensureSupported();
    const data = await this.rest('GET', 'cast/uploads/usage');
    if (
      !isRecord(data) ||
      typeof data['bytes'] !== 'number' ||
      typeof data['count'] !== 'number' ||
      typeof data['cap'] !== 'number'
    ) {
      throw new Error('The server returned an invalid upload usage response.');
    }
    return { bytes: data['bytes'], count: data['count'], cap: data['cap'] };
  }

  async clear(): Promise<{ freedBytes: number; retainedBytes: number }> {
    this.ensureSupported();
    const data = await this.rest('DELETE', 'cast/uploads');
    if (
      !isRecord(data) ||
      typeof data['freedBytes'] !== 'number' ||
      typeof data['retainedBytes'] !== 'number'
    ) {
      throw new Error('The server returned an invalid upload clear response.');
    }
    return {
      freedBytes: data['freedBytes'],
      retainedBytes: data['retainedBytes'],
    };
  }

  private uploadOnce(
    file: Blob,
    name: string,
    token: string,
    opts: { signal?: AbortSignal; onProgress?: (fraction: number) => void } | undefined,
    retried: boolean,
  ): Promise<UploadResult> {
    return new Promise<UploadResult>((resolve, reject) => {
      const signal = opts?.signal;
      if (signal?.aborted) {
        reject(abortError());
        return;
      }

      const xhr = new XMLHttpRequest();
      let settled = false;
      const cleanup = () => signal?.removeEventListener('abort', onAbort);
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const done = (value: UploadResult) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };
      const onAbort = () => {
        try {
          xhr.abort();
        } catch {
          // Already finished.
        }
        fail(abortError());
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      xhr.open('POST', joinUrl(this.options.baseUrl(), 'cast/uploads'), true);
      xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      const clientId = this.options.clientId?.().trim();
      if (clientId) xhr.setRequestHeader('X-Device-Id', clientId);
      if (xhr.upload) {
        xhr.upload.onprogress = (event: ProgressEvent) => {
          if (!event.lengthComputable || event.total <= 0) return;
          const fraction = Math.min(1, Math.max(0, event.loaded / event.total));
          try {
            opts?.onProgress?.(fraction);
          } catch {
            // Progress is cosmetic.
          }
        };
      }
      xhr.onerror = () =>
        fail(new Error('Could not upload the file. Check your connection.'));
      xhr.onabort = () => fail(abortError());
      xhr.ontimeout = () => fail(new Error('The upload timed out.'));
      xhr.onload = () => {
        const data = parseBody(xhr.responseText);
        if (xhr.status === 401 && !retried) {
          void this.options
            .refreshAccessToken()
            .then((fresh) => {
              if (settled || signal?.aborted) return;
              if (!fresh) {
                fail(new Error('Sign in again to cast music.'));
                return;
              }
              this.uploadOnce(file, name, fresh, opts, true).then(done, fail);
            })
            .catch(() => fail(new Error('Sign in again to cast music.')));
          return;
        }
        if (xhr.status < 200 || xhr.status >= 300) {
          fail(new Error(uploadError(data, xhr.status)));
          return;
        }
        if (!isRecord(data) || typeof data['uploadId'] !== 'string') {
          fail(new Error('The server did not accept the upload.'));
          return;
        }
        done({
          uploadId: data['uploadId'],
          sizeBytes:
            typeof data['sizeBytes'] === 'number'
              ? data['sizeBytes']
              : file.size,
          expiresAt:
            typeof data['expiresAt'] === 'number' ? data['expiresAt'] : 0,
        });
      };

      const form = new FormData();
      form.append('file', file, name);
      xhr.send(form);
    });
  }

  private async rest(method: 'GET' | 'DELETE', path: string): Promise<unknown> {
    const timeoutMs = SESSION_COMMAND_TIMEOUT_MS;
    const response =
      method === 'GET'
        ? await this.http.get<unknown>(path, undefined, { timeoutMs })
        : await this.http.delete<unknown>(path, { timeoutMs });
    if (response.status === 401) {
      throw new Error('Sign in again to manage the cast cache.');
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(
        errorText(response.data) ??
          `The server could not handle the request (${response.status}).`,
      );
    }
    if (response.data === undefined) {
      throw new Error('The server returned an empty response.');
    }
    return response.data;
  }

  private ensureSupported(): void {
    if (this.native) {
      throw new Error(
        'Uploading files for casting is only available in the browser.',
      );
    }
    let base = '';
    try {
      base = this.options.baseUrl().trim();
    } catch {
      base = '';
    }
    if (!base) throw new Error('Connect to the download server first.');
  }
}

export function createCastUploads(options: ServerCastOptions): CastUploadPort {
  return new ServerCastUploads(options);
}

function uploadError(data: unknown, status: number): string {
  const code = errorText(data);
  switch (code) {
    case 'upload-too-large':
    case 'file-too-large':
      return 'That file is too large to cast.';
    case 'uploads-disabled':
      return 'Casting uploads are turned off on this server.';
    case 'unauthorized':
    case 'account-required':
      return 'Sign in to cast music.';
    default:
      break;
  }
  if (status === 403) return 'Sessions need an account.';
  if (status === 413) return 'That file is too large to cast.';
  if (code) return code;
  return `Could not upload the file (${status}).`;
}
