import {
  Injectable,
  computed,
  inject,
  signal,
  type WritableSignal,
} from '@angular/core';
import {
  DEFAULT_AUDIO_QUALITY,
  isAudioQuality,
  parsePairingLink,
  type AudioQuality,
} from '@open-record/models';
import { SETTINGS_KEYS, StoragePort, type JsonValue } from '@open-record/storage';
import { RemoteServerPort } from './ports';
import { isAbort, remoteErrorMessage } from './remote-errors';

/** The self-hosted download server the app talks to. */
export interface DownloadServerSettings {
  url: string;
  token: string;
}

/** Outcome of pairing from a pasted or scanned link. */
export type PairResult = { ok: true } | { ok: false; message: string };

export type ConnectionState =
  | { status: 'idle' }
  | { status: 'testing' }
  | { status: 'ok' }
  | { status: 'error'; message: string };

const NO_SERVER: DownloadServerSettings = { url: '', token: '' };

/** Streaming and download quality levels. */
export interface AudioQualitySettings {
  stream: AudioQuality;
  download: AudioQuality;
  /** Downloads use the streaming level (the `download` value is kept but ignored). */
  sameForDownloads: boolean;
}

/** Background download switches. */
export interface AutoDownloadSettings {
  /** Keep every bookmarked library track saved on the device. */
  library: boolean;
  /** Allow auto-downloads on mobile data (otherwise Wi-Fi/Ethernet only). */
  mobileData: boolean;
}

export const DEFAULT_QUALITY_SETTINGS: AudioQualitySettings = {
  stream: DEFAULT_AUDIO_QUALITY,
  download: DEFAULT_AUDIO_QUALITY,
  sameForDownloads: false,
};

export const DEFAULT_AUTO_DOWNLOAD_SETTINGS: AutoDownloadSettings = {
  library: false,
  mobileData: false,
};

/**
 * App settings. Hydrates from storage on construction; setters persist
 * optimistically and roll back if the write fails.
 *
 * The download server URL + token live in the `settings` collection (the
 * repo has no secure-storage plugin) and are pushed to `RemoteServerPort`
 * at startup and whenever they change.
 */
@Injectable({ providedIn: 'root' })
export class SettingsStore {
  // Settings are read from and written to `storage.settings`.
  protected readonly storage = inject(StoragePort);
  private readonly remote = inject(RemoteServerPort, { optional: true });

  private readonly _hydrated = signal(false);
  private readonly _server = signal<DownloadServerSettings>(NO_SERVER);
  private readonly _serverReady = signal(false);
  private readonly _connection = signal<ConnectionState>({ status: 'idle' });
  private readonly _quality = signal<AudioQualitySettings>(DEFAULT_QUALITY_SETTINGS);
  private readonly _autoDownload = signal<AutoDownloadSettings>(
    DEFAULT_AUTO_DOWNLOAD_SETTINGS,
  );
  private testAbort?: AbortController;

  /** True once the stored settings have been read. */
  readonly hydrated = this._hydrated.asReadonly();
  /** The stream server is wired in this build (a RemoteServerPort is provided). */
  readonly serverAvailable = !!this.remote;
  /** Saved download server (empty strings when not set up). */
  readonly downloadServer = this._server.asReadonly();
  readonly downloadServerUrl = computed(() => this._server().url);
  readonly downloadServerToken = computed(() => this._server().token);
  /** A valid server URL is saved and applied, so search and downloads can run. */
  readonly downloadServerConfigured = this._serverReady.asReadonly();
  /** Settings "Test connection" state. */
  readonly connection = this._connection.asReadonly();

  /** Stored quality choices. */
  readonly audioQuality = this._quality.asReadonly();
  /** Quality requested when streaming. */
  readonly streamQuality = computed(() => this._quality().stream);
  /** Quality requested when saving to the device. */
  readonly downloadQuality = computed(() => {
    const q = this._quality();
    return q.sameForDownloads ? q.stream : q.download;
  });

  /** Stored auto-download switches. */
  readonly autoDownload = this._autoDownload.asReadonly();
  readonly autoDownloadLibrary = computed(() => this._autoDownload().library);
  readonly autoDownloadOnMobileData = computed(
    () => this._autoDownload().mobileData,
  );

  private loaded: Promise<void>;

  constructor() {
    this.loaded = this.hydrate();
  }

  ready(): Promise<void> {
    return this.loaded;
  }

  /** Re-read from storage (e.g. after a full reset). */
  async reload(): Promise<void> {
    this.loaded = this.hydrate();
    await this.loaded;
  }

  /**
   * Save the download server. A blank URL removes it. Throws (without saving)
   * for a URL that is not http(s), or if the write fails.
   */
  async setDownloadServer(next: DownloadServerSettings): Promise<void> {
    await this.loaded;
    const value: DownloadServerSettings = {
      url: next.url.trim(),
      token: next.token.trim(),
    };
    const before = this._server();
    if (value.url === before.url && value.token === before.token) return;
    this.apply(value, true);
    this._connection.set({ status: 'idle' });
    try {
      if (value.url)
        await this.storage.settings.set(SETTINGS_KEYS.downloadServer, {
          url: value.url,
          token: value.token,
        });
      else await this.storage.settings.delete(SETTINGS_KEYS.downloadServer);
    } catch (err) {
      this.apply(before, false);
      throw err;
    }
  }

  /** Change quality settings; persists, rolling back if the write fails. */
  async setAudioQuality(patch: Partial<AudioQualitySettings>): Promise<void> {
    await this.loaded;
    await this.persist(this._quality, SETTINGS_KEYS.audioQuality, patch);
  }

  /** Change auto-download switches; persists, rolling back if the write fails. */
  async setAutoDownload(patch: Partial<AutoDownloadSettings>): Promise<void> {
    await this.loaded;
    await this.persist(this._autoDownload, SETTINGS_KEYS.autoDownload, patch);
  }

  private async persist<T extends object>(
    target: WritableSignal<T>,
    key: string,
    patch: Partial<T>,
  ): Promise<void> {
    const before = target();
    const next = { ...before, ...patch };
    if (JSON.stringify(next) === JSON.stringify(before)) return;
    target.set(next);
    try {
      // Settings objects here are plain JSON (strings and booleans).
      await this.storage.settings.set(key, next as unknown as JsonValue);
    } catch (err) {
      target.set(before);
      throw err;
    }
  }

  /**
   * Pair with a server from an `openrecord://pair` link: save its URL and token,
   * then run the connection test. The settings stay saved even when the test
   * fails, so the message can be fixed in place.
   */
  async pairFromLink(text: string): Promise<PairResult> {
    await this.loaded;
    const link = parsePairingLink(text);
    if (!link)
      return { ok: false, message: 'That is not an Open Record pairing link.' };
    try {
      await this.setDownloadServer(link);
    } catch (err) {
      return {
        ok: false,
        message:
          err instanceof Error && err.message.startsWith('Enter')
            ? err.message
            : 'Could not save the server. Try again.',
      };
    }
    await this.testConnection();
    const state = this.connection();
    if (state.status === 'ok') return { ok: true };
    return {
      ok: false,
      message:
        state.status === 'error'
          ? state.message
          : 'Connection test did not finish. Try again.',
    };
  }

  /** Check the saved server is reachable and accepts the token. */
  async testConnection(): Promise<void> {
    await this.loaded;
    this.testAbort?.abort();
    if (!this.remote || !this._serverReady()) {
      this._connection.set({
        status: 'error',
        message: 'Enter a server URL first.',
      });
      return;
    }
    const abort = (this.testAbort = new AbortController());
    this._connection.set({ status: 'testing' });
    try {
      await this.remote.testConnection(abort.signal);
      if (!abort.signal.aborted) this._connection.set({ status: 'ok' });
    } catch (err) {
      if (abort.signal.aborted || isAbort(err)) return;
      this._connection.set({
        status: 'error',
        message: remoteErrorMessage(err),
      });
    }
  }

  /**
   * Push settings to the remote port. With `strict`, a bad URL throws a
   * friendly error; otherwise (stored values at startup) it just disables
   * the server.
   */
  private apply(value: DownloadServerSettings, strict: boolean): void {
    let ready = false;
    try {
      this.remote?.configure(
        value.url ? { baseUrl: value.url, token: value.token } : null,
      );
      ready = !!value.url && !!this.remote?.configured;
    } catch (err) {
      this.remote?.configure(null);
      if (strict)
        throw new Error('Enter a full http:// or https:// address.', {
          cause: err,
        });
    }
    this._server.set(value);
    this._serverReady.set(ready);
  }

  private async hydrate(): Promise<void> {
    this.testAbort?.abort();
    this._connection.set({ status: 'idle' });
    let stored: DownloadServerSettings | undefined;
    try {
      const raw = await this.storage.settings.get<{
        url?: string;
        token?: string;
      }>(SETTINGS_KEYS.downloadServer);
      if (raw && typeof raw.url === 'string')
        stored = { url: raw.url, token: raw.token ?? '' };
    } catch {
      // Unreadable settings fall back to defaults.
    }
    this.apply(stored ?? NO_SERVER, false);
    this._quality.set(await this.readQuality());
    this._autoDownload.set(await this.readAutoDownload());
    this._hydrated.set(true);
  }

  private async readQuality(): Promise<AudioQualitySettings> {
    try {
      const raw = await this.storage.settings.get<Partial<AudioQualitySettings>>(
        SETTINGS_KEYS.audioQuality,
      );
      const d = DEFAULT_QUALITY_SETTINGS;
      return {
        stream: isAudioQuality(raw?.stream) ? raw.stream : d.stream,
        download: isAudioQuality(raw?.download) ? raw.download : d.download,
        sameForDownloads:
          typeof raw?.sameForDownloads === 'boolean'
            ? raw.sameForDownloads
            : d.sameForDownloads,
      };
    } catch {
      return DEFAULT_QUALITY_SETTINGS;
    }
  }

  private async readAutoDownload(): Promise<AutoDownloadSettings> {
    try {
      const raw = await this.storage.settings.get<Partial<AutoDownloadSettings>>(
        SETTINGS_KEYS.autoDownload,
      );
      return {
        library: raw?.library === true,
        mobileData: raw?.mobileData === true,
      };
    } catch {
      return DEFAULT_AUTO_DOWNLOAD_SETTINGS;
    }
  }
}
