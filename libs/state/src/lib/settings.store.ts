import { Injectable, computed, inject, signal } from '@angular/core';
import { SETTINGS_KEYS, StoragePort } from '@open-record/storage';
import { RemoteDownloadPort } from './ports';
import { isAbort, remoteErrorMessage } from './remote-errors';

/** The self-hosted download server the app talks to. */
export interface DownloadServerSettings {
  url: string;
  token: string;
}

export type ConnectionState =
  | { status: 'idle' }
  | { status: 'testing' }
  | { status: 'ok' }
  | { status: 'error'; message: string };

const NO_SERVER: DownloadServerSettings = { url: '', token: '' };

/**
 * App settings. Hydrates from storage on construction; setters persist
 * optimistically and roll back if the write fails.
 *
 * The download server URL + token live in the `settings` collection (the
 * repo has no secure-storage plugin) and are pushed to `RemoteDownloadPort`
 * at startup and whenever they change.
 */
@Injectable({ providedIn: 'root' })
export class SettingsStore {
  // Settings are read from and written to `storage.settings`.
  protected readonly storage = inject(StoragePort);
  private readonly remote = inject(RemoteDownloadPort, { optional: true });

  private readonly _hydrated = signal(false);
  private readonly _server = signal<DownloadServerSettings>(NO_SERVER);
  private readonly _serverReady = signal(false);
  private readonly _connection = signal<ConnectionState>({ status: 'idle' });
  private testAbort?: AbortController;

  /** True once the stored settings have been read. */
  readonly hydrated = this._hydrated.asReadonly();
  /** Downloading is wired in this build (a RemoteDownloadPort is provided). */
  readonly downloadsAvailable = !!this.remote;
  /** Saved download server (empty strings when not set up). */
  readonly downloadServer = this._server.asReadonly();
  readonly downloadServerUrl = computed(() => this._server().url);
  readonly downloadServerToken = computed(() => this._server().token);
  /** A valid server URL is saved and applied, so search and downloads can run. */
  readonly downloadServerConfigured = this._serverReady.asReadonly();
  /** Settings "Test connection" state. */
  readonly connection = this._connection.asReadonly();

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
    this._hydrated.set(true);
  }
}
