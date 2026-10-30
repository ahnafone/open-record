// `castv2-client@1.2.0` ships no types. This is the minimal surface used by
// `services/cast-transport.ts`; everything else stays undeclared on purpose so
// the wrapper (not callers) is the only place that touches the package.
declare module 'castv2-client' {
  /** Node-style callback; the value is absent on error. */
  export type CastCallback<T> = (error: Error | null, value?: T) => void;

  export interface CastConnectOptions {
    host: string;
    /** Defaults to 8009 in castv2. */
    port?: number;
  }

  /**
   * The underlying `castv2` TLS client held as `Client.client`. It emits
   * `close` when the socket goes away and `error` for TLS/socket failures.
   */
  export interface CastSocket {
    on(event: 'close', listener: () => void): this;
    on(event: 'error', listener: (error: Error) => void): this;
    once(event: 'close', listener: () => void): this;
    once(event: 'error', listener: (error: Error) => void): this;
    removeListener(event: 'close', listener: () => void): this;
    removeListener(event: 'error', listener: (error: Error) => void): this;
  }

  export interface CastVolume {
    level?: number;
    muted?: boolean;
  }

  export interface CastReceiverApplication {
    appId?: string;
    displayName?: string;
    sessionId?: string;
    transportId?: string;
  }

  /** `RECEIVER_STATUS` payload returned by `getStatus` and volume calls. */
  export interface CastReceiverStatus {
    volume?: CastVolume;
    applications?: CastReceiverApplication[];
  }

  export interface CastMediaMetadata {
    /** Generic media metadata (0) as sent by the DefaultMediaReceiver. */
    type?: number;
    metadataType?: number;
    title?: string;
    artist?: string;
    images?: { url: string }[];
  }

  export interface CastMediaInformation {
    contentId: string;
    contentType: string;
    streamType?: 'BUFFERED' | 'LIVE';
    duration?: number;
    metadata?: CastMediaMetadata;
  }

  export interface CastLoadOptions {
    autoplay?: boolean;
    currentTime?: number;
    activeTrackIds?: number[];
    repeatMode?: string;
  }

  /** One entry of a `MEDIA_STATUS` broadcast. */
  export interface CastMediaStatus {
    mediaSessionId?: number;
    /** `PLAYING` | `PAUSED` | `BUFFERING` | `IDLE` (other values possible). */
    playerState?: string;
    currentTime?: number;
    /** `FINISHED` | `CANCELLED` | `ERROR` | `INTERRUPTED` (other values possible). */
    idleReason?: string;
    /** The receiver fills in more here; the transport only needs the duration. */
    media?: { duration?: number };
  }

  /** The `DefaultMediaReceiver` app instance returned by `Client.launch`. */
  export interface DefaultMediaReceiver {
    on(event: 'status', listener: (status: CastMediaStatus) => void): this;
    on(event: 'close', listener: () => void): this;
    removeListener(event: 'status', listener: (status: CastMediaStatus) => void): this;
    removeListener(event: 'close', listener: () => void): this;
    load(media: CastMediaInformation, options: CastLoadOptions, callback: CastCallback<CastMediaStatus>): void;
    play(callback?: CastCallback<CastMediaStatus>): void;
    pause(callback?: CastCallback<CastMediaStatus>): void;
    stop(callback?: CastCallback<CastMediaStatus>): void;
    seek(currentTime: number, callback?: CastCallback<CastMediaStatus>): void;
    getStatus(callback: CastCallback<CastMediaStatus>): void;
    close(): void;
  }

  /** A receiver application constructor, e.g. `DefaultMediaReceiver`. */
  export interface CastApplication {
    APP_ID: string;
  }

  /** The constructor value (`CC1AD845`) passed to `Client.launch`. */
  export const DefaultMediaReceiver: {
    readonly APP_ID: string;
  };

  /** Platform sender (`castv2-client`'s `Client`). */
  export class Client {
    constructor();
    /** The underlying TLS client; emits `close`/`error` for the socket. */
    readonly client: CastSocket;
    connect(hostOrOptions: string | CastConnectOptions, callback: () => void): void;
    launch(app: CastApplication, callback: CastCallback<DefaultMediaReceiver>): void;
    getStatus(callback: CastCallback<CastReceiverStatus>): void;
    getVolume(callback: CastCallback<CastVolume>): void;
    setVolume(volume: CastVolume, callback: CastCallback<CastVolume>): void;
    close(): void;
    on(event: 'error', listener: (error: Error) => void): this;
    once(event: 'error', listener: (error: Error) => void): this;
    removeListener(event: 'error', listener: (error: Error) => void): this;
  }
}
