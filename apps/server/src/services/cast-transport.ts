import {
  Client,
  DefaultMediaReceiver,
  type CastMediaStatus,
  type CastVolume,
} from 'castv2-client';

/** Default per-command timeout; launch/load are slower because they involve the device UI. */
const CALLBACK_TIMEOUT_MS = 10_000;
const LAUNCH_TIMEOUT_MS = 20_000;
const LOAD_TIMEOUT_MS = 20_000;
const DEFAULT_CONTENT_TYPE = 'audio/mp4';
const DEFAULT_VOLUME = 1;

/** Snapshot of what the receiver is doing, in the shape the session expects. */
export interface CastStatus {
  playing: boolean;
  positionSec: number;
  durationSec?: number;
  /** True once the receiver reached the end of the media (`idleReason: FINISHED`). */
  idle?: boolean;
  volume: number;
}

export interface CastTransport {
  connect(host: string, port: number): Promise<void>;
  load(
    media: {
      url: string;
      contentType: string;
      title: string;
      artist: string;
      artUrl?: string;
      durationSec?: number;
    },
    opts: { startSec?: number; autoplay: boolean },
  ): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  stop(): Promise<void>;
  seek(sec: number): Promise<void>;
  setVolume(level: number): Promise<void>;
  status(): CastStatus | null;
  /** Pull the receiver's current MEDIA_STATUS (the receiver does not push periodic updates). */
  getStatus(): Promise<CastStatus | null>;
  onStatus(listener: (status: CastStatus) => void): () => void;
  onDisconnect(listener: () => void): () => void;
  close(): Promise<void>;
}

/**
 * Pure `MEDIA_STATUS` → `CastStatus` mapping, exported so it can be tested
 * without a device or a socket. Volume is receiver state, not media state, so
 * the caller supplies the latest known level.
 */
export function toCastStatus(status: CastMediaStatus, volume: number): CastStatus {
  const durationSec = positiveNumber(status.media?.duration);
  return {
    playing: status.playerState === 'PLAYING',
    positionSec: positiveNumber(status.currentTime) ?? 0,
    ...(durationSec !== undefined ? { durationSec } : {}),
    ...(status.idleReason === 'FINISHED' ? { idle: true } : {}),
    volume: normaliseVolume(volume),
  };
}

/** No I/O happens here; the socket is opened by `connect`. */
export function createCastTransport(): CastTransport {
  return new Castv2Transport();
}

type Done<T> = (error: Error | null, value?: T) => void;

class Castv2Transport implements CastTransport {
  private client: Client | null = null;
  private player: DefaultMediaReceiver | null = null;
  private current: CastStatus | null = null;
  private volume = DEFAULT_VOLUME;
  /** Suppresses disconnect events caused by our own `close()`. */
  private closing = false;
  /** True between a successful `connect()` and `close()`. */
  private connected = false;
  /** `onDisconnect` fires once per connection. */
  private disconnected = false;
  /** A socket/app loss seen before `connect()` finished resolving. */
  private pendingDisconnect = false;
  private handlers: { client: Client; onError: () => void; onClose: () => void } | null = null;
  private readonly statusListeners = new Set<(status: CastStatus) => void>();
  private readonly disconnectListeners = new Set<() => void>();

  private readonly onMediaStatus = (status: CastMediaStatus): void => {
    if (this.closing) return;
    const mapped = toCastStatus(status, this.volume);
    this.current = mapped;
    for (const listener of [...this.statusListeners]) {
      try {
        listener({ ...mapped });
      } catch {
        // A broken consumer must not break the socket's event loop.
      }
    }
  };

  private readonly onPlayerClose = (): void => {
    // The receiver closed the app connection (app stopped on the device).
    this.emitDisconnect();
  };

  async connect(host: string, port: number): Promise<void> {
    // Simple idempotency: a second connect replaces the previous session.
    await this.close();
    this.closing = false;
    this.connected = false;
    this.disconnected = false;
    this.pendingDisconnect = false;
    this.current = null;
    this.volume = DEFAULT_VOLUME;

    const client = new Client();
    this.client = client;
    // Per-connection handlers: a late event from a replaced client is inert.
    const onError = (): void => {
      if (this.client !== client) return;
      // The sender forwards TLS, protocol and heartbeat errors.
      this.emitDisconnect();
    };
    const onClose = (): void => {
      if (this.client !== client) return;
      this.emitDisconnect();
    };
    this.handlers = { client, onError, onClose };
    client.client.once('close', onClose);
    client.on('error', onError);

    try {
      await this.open(host, port);
      const player = await waitForCallback<DefaultMediaReceiver>('cast launch', LAUNCH_TIMEOUT_MS, (done) =>
        client.launch(DefaultMediaReceiver, done),
      );
      this.player = player;
      player.on('status', this.onMediaStatus);
      player.on('close', this.onPlayerClose);

      const volume = await waitForCallback<CastVolume>('cast volume', CALLBACK_TIMEOUT_MS, (done) =>
        client.getVolume(done),
      );
      this.volume = normaliseVolume(volume.level);
      this.current = { playing: false, positionSec: 0, volume: this.volume };
      this.connected = true;
      if (this.pendingDisconnect) this.emitDisconnect();
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async load(
    media: {
      url: string;
      contentType: string;
      title: string;
      artist: string;
      artUrl?: string;
      durationSec?: number;
    },
    opts: { startSec?: number; autoplay: boolean },
  ): Promise<void> {
    const player = this.requirePlayer();
    const startSec = positiveNumber(opts.startSec) ?? 0;
    const status = await waitForCallback<CastMediaStatus>('cast load', LOAD_TIMEOUT_MS, (done) =>
      player.load(
        {
          contentId: media.url,
          contentType: media.contentType || DEFAULT_CONTENT_TYPE,
          streamType: 'BUFFERED',
          metadata: {
            type: 0,
            metadataType: 0,
            title: media.title,
            artist: media.artist,
            ...(media.artUrl ? { images: [{ url: media.artUrl }] } : {}),
          },
        },
        { autoplay: opts.autoplay, currentTime: startSec },
        done,
      ),
    );
    // The load response is not broadcast as a `status` event, so seed the
    // snapshot without emitting (consumers may still be wiring their state).
    this.current = toCastStatus(status, this.volume);
  }

  async play(): Promise<void> {
    const player = this.requirePlayer();
    await runCallback('cast play', CALLBACK_TIMEOUT_MS, (done) => player.play((error) => done(error)));
  }

  async pause(): Promise<void> {
    const player = this.requirePlayer();
    await runCallback('cast pause', CALLBACK_TIMEOUT_MS, (done) => player.pause((error) => done(error)));
  }

  async stop(): Promise<void> {
    const player = this.requirePlayer();
    await runCallback('cast stop', CALLBACK_TIMEOUT_MS, (done) => player.stop((error) => done(error)));
  }

  async seek(sec: number): Promise<void> {
    if (!Number.isFinite(sec)) throw new Error('cast seek position must be a finite number');
    const player = this.requirePlayer();
    const target = Math.max(0, sec);
    await runCallback('cast seek', CALLBACK_TIMEOUT_MS, (done) => player.seek(target, (error) => done(error)));
  }

  async setVolume(level: number): Promise<void> {
    if (!Number.isFinite(level)) throw new Error('cast volume must be a finite number');
    const client = this.requireClient();
    const target = clampVolume(level);
    const volume = await waitForCallback<CastVolume>('cast volume', CALLBACK_TIMEOUT_MS, (done) =>
      client.setVolume({ level: target }, done),
    );
    this.volume = normaliseVolume(volume.level ?? target);
    if (this.current) this.current = { ...this.current, volume: this.volume };
  }

  status(): CastStatus | null {
    return this.current ? { ...this.current } : null;
  }

  async getStatus(): Promise<CastStatus | null> {
    const player = this.player;
    if (!player) return null;
    const status = await waitForCallback<CastMediaStatus>('cast status', CALLBACK_TIMEOUT_MS, (done) =>
      player.getStatus(done),
    );
    const mapped = toCastStatus(status, this.volume);
    this.current = mapped;
    return { ...mapped };
  }

  onStatus(listener: (status: CastStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  onDisconnect(listener: () => void): () => void {
    this.disconnectListeners.add(listener);
    // A listener attached just after the device vanished should still learn
    // about it (the CastService may wire handlers right after `connect`).
    if (this.connected && this.disconnected && !this.closing) {
      queueMicrotask(() => {
        if (!this.connected || !this.disconnected || this.closing) return;
        if (this.disconnectListeners.has(listener)) this.notifyDisconnect(listener);
      });
    }
    return () => {
      this.disconnectListeners.delete(listener);
    };
  }

  /** Stops playback (best effort) and tears the socket down. Safe to call twice. */
  async close(): Promise<void> {
    this.closing = true;
    this.connected = false;
    const client = this.client;
    const player = this.player;
    const handlers = this.handlers;
    this.client = null;
    this.player = null;
    this.handlers = null;

    if (player) {
      player.removeListener('status', this.onMediaStatus);
      player.removeListener('close', this.onPlayerClose);
    }
    if (handlers) {
      // Keep `onError` attached: the sender can emit a late socket error
      // during teardown, and an unhandled EventEmitter 'error' would crash.
      // It is inert because `this.client` no longer matches its connection.
      handlers.client.client.removeListener('close', handlers.onClose);
    }

    if (player) {
      try {
        await runCallback('cast stop', CALLBACK_TIMEOUT_MS, (done) => player.stop((error) => done(error)));
      } catch {
        // The receiver may already be gone (or no media was loaded); the
        // socket teardown below is still enough to release the device.
      }
    }

    if (client) {
      try {
        client.close();
      } catch {
        // `castv2` throws when the socket was already destroyed.
      }
    }

    this.current = null;
    this.volume = DEFAULT_VOLUME;
    this.pendingDisconnect = false;
    // `closing` stays true so nothing from the old connection is surfaced;
    // `connect` clears it for the next session.
  }

  private async open(host: string, port: number): Promise<void> {
    const client = this.requireClient();
    await runCallback('cast connect', CALLBACK_TIMEOUT_MS, (done) => {
      // `castv2-client`'s connect callback has no error argument, so surface
      // TLS/protocol failures through the socket's own error event.
      const onError = (error: Error): void => done(error);
      client.client.once('error', onError);
      client.connect({ host, port }, () => {
        client.client.removeListener('error', onError);
        done(null);
      });
    });
  }

  private emitDisconnect(): void {
    // A failed `connect()` rejects; it must not also look like a live
    // connection dropping. A loss seen during `connect()` is replayed once it
    // resolves, so a dead receiver cannot slip through the setup window.
    if (this.closing || this.disconnected) return;
    if (!this.connected) {
      this.pendingDisconnect = true;
      return;
    }
    this.disconnected = true;
    for (const listener of [...this.disconnectListeners]) this.notifyDisconnect(listener);
  }

  private notifyDisconnect(listener: () => void): void {
    try {
      listener();
    } catch {
      // Disconnect handling is best effort.
    }
  }

  private requireClient(): Client {
    if (!this.client) throw new Error('cast transport is not connected');
    return this.client;
  }

  private requirePlayer(): DefaultMediaReceiver {
    if (!this.player) throw new Error('cast transport is not connected');
    return this.player;
  }
}

function waitForCallback<T>(label: string, timeoutMs: number, invoke: (done: Done<T>) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`${label} timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    timer.unref();

    const finish = (error: Error | null, value?: T): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        reject(error);
        return;
      }
      if (value === undefined) {
        reject(new Error(`${label} returned no result`));
        return;
      }
      resolve(value);
    };

    try {
      invoke(finish);
    } catch (error) {
      finish(asError(error));
    }
  });
}

function runCallback(
  label: string,
  timeoutMs: number,
  invoke: (done: (error: Error | null) => void) => void,
): Promise<void> {
  return waitForCallback<true>(label, timeoutMs, (done) => {
    invoke((error) => done(error, error ? undefined : true));
  }).then(() => undefined);
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function positiveNumber(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function clampVolume(level: number): number {
  return Math.min(1, Math.max(0, level));
}

function normaliseVolume(level: number | undefined): number {
  return typeof level === 'number' && Number.isFinite(level) ? clampVolume(level) : DEFAULT_VOLUME;
}
