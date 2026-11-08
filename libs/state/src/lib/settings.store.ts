import {
  Injectable,
  computed,
  inject,
  signal,
  type WritableSignal,
} from '@angular/core';
import {
  DEFAULT_AUDIO_QUALITY,
  DEFAULT_DOWNLOAD_LOCATION,
  isAudioQuality,
  isDownloadLocation,
  parsePairingLink,
  type AudioQuality,
  type DownloadLocation,
} from '@open-record/models';
import { SETTINGS_KEYS, StoragePort, type JsonValue } from '@open-record/storage';
import { AuthStore } from './auth.store';
import {
  MAX_DEVICE_NAME_LENGTH,
  defaultDeviceName,
  ensureDeviceId,
} from './device-identity';
import { PUBLIC_SERVER, RemoteServerPort } from './ports';
import { isAbort, remoteErrorMessage } from './remote-errors';

/**
 * `own`: talk to the server the user entered. `public`: talk to the public
 * Open Record server (sign in or request access there).
 */
export type ConnectionMode = 'own' | 'public';

/** Settings key for the connection mode (the own server stays under `downloadServer`). */
const CONNECTION_MODE_KEY = 'connectionMode';

/** The self-hosted download server the app talks to. */
export interface DownloadServerSettings {
  url: string;
  /**
   * Legacy static token (never asked for in the UI). Signed-in users send
   * their account token instead; this is only a fallback for headless setups.
   */
  token: string;
}

/** Outcome of pairing from a pasted or scanned link. */
export type PairResult =
  | { ok: true; message?: string }
  | { ok: false; message: string };

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

/** Which session features this device takes part in. */
export interface SessionPrefs {
  /** Join and control a playback session. */
  session: boolean;
  /** Drive a cast target. */
  cast: boolean;
}

export const DEFAULT_SESSION_PREFS: SessionPrefs = {
  session: true,
  cast: true,
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
  private readonly auth = inject(AuthStore);
  /** Public server URL for this build ('' hides the option). */
  private readonly publicUrl = (inject(PUBLIC_SERVER, { optional: true }) ?? '').trim();

  private readonly _hydrated = signal(false);
  /** The effective server: the public one in public mode, else the own one. */
  private readonly _server = signal<DownloadServerSettings>(NO_SERVER);
  /** The own server the user entered (kept while in public mode). */
  private readonly _own = signal<DownloadServerSettings>(NO_SERVER);
  private readonly _mode = signal<ConnectionMode>('own');
  private readonly _serverReady = signal(false);
  private readonly _connection = signal<ConnectionState>({ status: 'idle' });
  private readonly _quality = signal<AudioQualitySettings>(DEFAULT_QUALITY_SETTINGS);
  private readonly _autoDownload = signal<AutoDownloadSettings>(
    DEFAULT_AUTO_DOWNLOAD_SETTINGS,
  );
  private readonly _downloadLocation = signal<DownloadLocation>(
    DEFAULT_DOWNLOAD_LOCATION,
  );
  private readonly _deviceId = signal('');
  private readonly _deviceName = signal('');
  private readonly _sessionPrefs = signal<SessionPrefs>(DEFAULT_SESSION_PREFS);
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
  /** The own server's URL (kept while the public server is in use). */
  readonly ownServerUrl = computed(() => this._own().url);
  /** Which server the app talks to. */
  readonly connectionMode = this._mode.asReadonly();
  /** This build offers the public server (its URL is set). */
  readonly publicServerAvailable = !!this.publicUrl;
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

  /** Where new downloads are written (existing files stay where they are). */
  readonly downloadLocation = this._downloadLocation.asReadonly();

  /** Stable per-install device id; non-empty once `ready()` resolves. */
  readonly deviceId = computed(() => this._deviceId());
  /** Name shown in the session device picker. */
  readonly deviceName = computed(
    () => this._deviceName() || defaultDeviceName(),
  );
  /** Session participation switches (both on by default). */
  readonly sessionEnabled = computed(() => this._sessionPrefs().session);
  readonly castEnabled = computed(() => this._sessionPrefs().cast);

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
   * Save the download server. A blank URL removes it. Without `token`, a
   * saved legacy token is kept only while the URL stays the same. Throws
   * (without saving) for a URL that is not http(s), or if the write fails.
   */
  async setDownloadServer(next: {
    url: string;
    token?: string;
  }): Promise<void> {
    await this.loaded;
    const before = this._own();
    const url = next.url.trim();
    const value: DownloadServerSettings = {
      url,
      token:
        next.token?.trim() ?? (url === before.url ? before.token : ''),
    };
    if (value.url === before.url && value.token === before.token) return;
    const live = this._mode() === 'own';
    // In public mode the own server is only saved; the app keeps talking to
    // the public server until the user switches back.
    if (live) this.apply(value, true);
    this._own.set(value);
    this._connection.set({ status: 'idle' });
    try {
      if (value.url)
        await this.storage.settings.set(SETTINGS_KEYS.downloadServer, {
          url: value.url,
          token: value.token,
        });
      else await this.storage.settings.delete(SETTINGS_KEYS.downloadServer);
    } catch (err) {
      this._own.set(before);
      if (live) this.apply(before, false);
      throw err;
    }
  }

  /**
   * Switch between the own server and the public server. The own server's
   * saved address is kept either way. Persists the mode and rolls back if the
   * write fails.
   */
  async setConnectionMode(mode: ConnectionMode): Promise<void> {
    await this.loaded;
    if (mode === 'public' && !this.publicUrl)
      throw new Error('The public server is not available in this build.');
    const before = this._mode();
    if (mode === before) return;
    this._mode.set(mode);
    this.auth.setPublicServer(mode === 'public');
    this.apply(this.effectiveServer(), false);
    this._connection.set({ status: 'idle' });
    try {
      await this.storage.settings.set(CONNECTION_MODE_KEY, mode);
    } catch (err) {
      this._mode.set(before);
      this.auth.setPublicServer(before === 'public');
      this.apply(this.effectiveServer(), false);
      throw err;
    }
  }

  /** The server the app should talk to for the current mode. */
  private effectiveServer(): DownloadServerSettings {
    if (this._mode() === 'public') return { url: this.publicUrl, token: '' };
    return this._own();
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

  /** Change where new downloads go; persists, rolling back if the write fails. */
  async setDownloadLocation(location: DownloadLocation): Promise<void> {
    await this.loaded;
    const before = this._downloadLocation();
    if (location === before) return;
    this._downloadLocation.set(location);
    try {
      await this.storage.settings.set(SETTINGS_KEYS.downloadLocation, location);
    } catch (err) {
      this._downloadLocation.set(before);
      throw err;
    }
  }

  /**
   * Rename this device (trimmed, at most 60 characters). A blank name falls
   * back to the platform default; the write rolls back on failure.
   */
  async setDeviceName(name: string): Promise<void> {
    await this.loaded;
    const before = this._deviceName();
    const trimmed = name.trim().slice(0, MAX_DEVICE_NAME_LENGTH);
    const next = trimmed || defaultDeviceName();
    if (next === this.deviceName()) return;
    this._deviceName.set(next);
    try {
      await this.storage.settings.set(SETTINGS_KEYS.deviceName, next);
    } catch (err) {
      this._deviceName.set(before);
      throw err;
    }
  }

  /** Allow or refuse session participation; persists, rolling back on failure. */
  async setSessionEnabled(enabled: boolean): Promise<void> {
    await this.loaded;
    await this.persist(this._sessionPrefs, SETTINGS_KEYS.sessionPrefs, {
      session: enabled,
    });
  }

  /** Allow or refuse casting; persists, rolling back on failure. */
  async setCastEnabled(enabled: boolean): Promise<void> {
    await this.loaded;
    await this.persist(this._sessionPrefs, SETTINGS_KEYS.sessionPrefs, {
      cast: enabled,
    });
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
   * Pair with a server from an `openrecord://pair` link: save its address
   * (any token in the link is ignored), then check it. Signed in, the check is
   * authenticated (`/health` + `/ping`); signed out (e.g. a phone before
   * signing in), it is the unauthenticated `/health` + `/app-config` probe, so
   * reachability does not look like a failure. The settings stay saved even
   * when the check fails, so the address can be fixed in place.
   */
  async pairFromLink(text: string): Promise<PairResult> {
    await this.loaded;
    const link = parsePairingLink(text);
    if (!link)
      return { ok: false, message: 'That is not an Open Record pairing link.' };
    if (this._mode() === 'public')
      return {
        ok: false,
        message: 'Turn off the public server in Settings to pair with your own server.',
      };
    try {
      await this.setDownloadServer({ url: link.url });
    } catch (err) {
      return {
        ok: false,
        message:
          err instanceof Error && err.message.startsWith('Enter')
            ? err.message
            : 'Could not save the server. Try again.',
      };
    }
    await this.auth.start();
    if (this.auth.signedIn()) {
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
    return this.probePairing();
  }

  /**
   * Signed-out pairing check: reachable server, no account token required.
   * The authenticated test stays for signed-in users above.
   */
  private async probePairing(): Promise<PairResult> {
    this.testAbort?.abort();
    if (!this.remote || !this._serverReady()) {
      this._connection.set({
        status: 'error',
        message: 'Enter a server URL first.',
      });
      return { ok: false, message: 'Enter a server URL first.' };
    }
    const abort = (this.testAbort = new AbortController());
    this._connection.set({ status: 'testing' });
    try {
      await this.remote.probeServer(abort.signal);
      if (abort.signal.aborted)
        return { ok: false, message: 'Connection test did not finish. Try again.' };
      this._connection.set({ status: 'ok' });
      return { ok: true, message: 'Saved — sign in to continue' };
    } catch (err) {
      if (abort.signal.aborted || isAbort(err))
        return { ok: false, message: 'Connection test did not finish. Try again.' };
      const message = remoteErrorMessage(err);
      this._connection.set({ status: 'error', message });
      return { ok: false, message };
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
    // Independent rows: read them in parallel (one round trip of latency on
    // the native bridge instead of four). Each read handles its own failure.
    const [
      server,
      quality,
      autoDownload,
      downloadLocation,
      deviceId,
      deviceName,
      sessionPrefs,
      mode,
    ] = await Promise.all([
      this.readServer(),
      this.readQuality(),
      this.readAutoDownload(),
      this.readDownloadLocation(),
      ensureDeviceId(this.storage),
      this.readDeviceName(),
      this.readSessionPrefs(),
      this.readConnectionMode(),
    ]);
    this._own.set(server);
    this._mode.set(mode);
    this.auth.setPublicServer(mode === 'public');
    this.apply(this.effectiveServer(), false);
    this._quality.set(quality);
    this._autoDownload.set(autoDownload);
    this._downloadLocation.set(downloadLocation);
    this._deviceId.set(deviceId);
    this._deviceName.set(deviceName);
    this._sessionPrefs.set(sessionPrefs);
    this._hydrated.set(true);
  }

  private async readServer(): Promise<DownloadServerSettings> {
    try {
      const raw = await this.storage.settings.get<{
        url?: string;
        token?: string;
      }>(SETTINGS_KEYS.downloadServer);
      if (raw && typeof raw.url === 'string')
        return { url: raw.url, token: raw.token ?? '' };
    } catch {
      // Unreadable settings fall back to defaults.
    }
    return NO_SERVER;
  }

  private async readConnectionMode(): Promise<ConnectionMode> {
    try {
      const raw = await this.storage.settings.get<string>(CONNECTION_MODE_KEY);
      // Public mode only sticks when this build has a public server.
      if (raw === 'public' && this.publicUrl) return 'public';
    } catch {
      // Unreadable settings fall back to the own server.
    }
    return 'own';
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
      // A failed read must not silently switch auto-download off: keep what
      // is loaded (the defaults on first read).
      return this._autoDownload();
    }
  }

  private async readDownloadLocation(): Promise<DownloadLocation> {
    try {
      const raw = await this.storage.settings.get<string>(
        SETTINGS_KEYS.downloadLocation,
      );
      return isDownloadLocation(raw) ? raw : DEFAULT_DOWNLOAD_LOCATION;
    } catch {
      return DEFAULT_DOWNLOAD_LOCATION;
    }
  }

  private async readDeviceName(): Promise<string> {
    try {
      const raw = await this.storage.settings.get<string>(
        SETTINGS_KEYS.deviceName,
      );
      if (typeof raw === 'string')
        return raw.trim().slice(0, MAX_DEVICE_NAME_LENGTH);
    } catch {
      // Keep the current name (the platform default on first read).
    }
    return this._deviceName();
  }

  private async readSessionPrefs(): Promise<SessionPrefs> {
    try {
      const raw = await this.storage.settings.get<Partial<SessionPrefs>>(
        SETTINGS_KEYS.sessionPrefs,
      );
      return {
        session: raw?.session !== false,
        cast: raw?.cast !== false,
      };
    } catch {
      // A failed read keeps what is loaded (both on by default).
      return this._sessionPrefs();
    }
  }
}
