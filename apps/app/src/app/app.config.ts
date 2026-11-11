import {
  ApplicationConfig,
  effect,
  inject,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
  type Provider,
} from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { provideRouter, withComponentInputBinding, withRouterConfig } from '@angular/router';
import { MusicSourceRegistry } from '@open-record/music-source';
import { providePlayer } from '@open-record/player';
import { CatalogProvider } from '@open-record/providers/catalog';
import { LocalProvider, createDefaultFileStore, pickTextFile } from '@open-record/providers/local';
import {
  REMOTE_PROVIDER_ID,
  RemoteProvider,
  createDefaultTransport,
} from '@open-record/providers/remote';
import {
  AUTH_ACCESS_RECHECK,
  AuthPort,
  AuthStore,
  BackgroundWorkPort,
  CastFilePort,
  CastUploadPort,
  DeviceStoragePort,
  ImportFilePort,
  LocalMediaPort,
  METADATA_FETCH,
  NetworkStatusPort,
  PUBLIC_SERVER,
  PairingScannerPort,
  PlayCountsPort,
  RemoteServerPort,
  SessionPort,
  SettingsStore,
  StackSyncPort,
  StreamResolverPort,
  SyncPort,
  UPDATE_APP_VERSION,
  UPDATE_PLATFORM,
  UpdateStore,
  WEB_BUILD,
  isBusy,
  provideState,
  remoteErrorMessage,
} from '@open-record/state';
import { StoragePort, provideStorage } from '@open-record/storage';
import { appRoutes } from './app.routes';
import { createBackgroundWork } from './background-work';
import { connectDesktop, getDesktopBridge } from './desktop-bridge';
import { createDeviceStorage } from './device-storage';
import { createNeighbourResolver } from './neighbour-resolver';
import { lookupRemoteArtist, metadataFetch } from './metadata-fetch';
import { createNetworkStatus } from './network-status';
import { PlatformPairingScanner } from './pairing-scanner';
import { PUBLIC_SERVER_URL } from './public-server.config';
import {
  createCastFiles,
  createCastUploads,
  createSessionPort,
  type ServerSessionOptions,
} from './server-session';
import { SupabaseAuth } from './supabase-auth';
import { SupabasePlayCounts } from './supabase-play-counts';
import { SupabaseStackSync } from './supabase-stack';
import { SupabaseSync } from './supabase-sync';
import { SUPABASE_BUILD_CONFIG } from './supabase.config';
import { createUpdatePlatform } from './update-platform';
import { autoPairWeb } from './web-pairing';
// Root package.json: a named JSON import keeps only `version` in the bundle (same as features/about).
// eslint-disable-next-line @nx/enforce-module-boundaries
import { version as APP_VERSION } from '../../../../package.json';

/** Music sources registered at startup; the UI never sees a concrete provider. */
const sources = new MusicSourceRegistry();

/**
 * Storage is injected at app start (see `provideAppInitializer`); the remote
 * provider is built before that, so it reads the saved-file record lazily.
 */
let storage: StoragePort | undefined;
/** Read lazily for the streaming quality and server URL (set at app start, like `storage`). */
let settings: SettingsStore | undefined;
/** Resolves once the app initializer has assigned `settings` (account start-up may run first). */
let settingsReady!: () => void;
const settingsAssigned = new Promise<void>((resolve) => (settingsReady = resolve));
/** Set at app start; opens the sign-in prompt when the server rejects a call. */
let auth: AuthStore | undefined;

/** The web build: neither the Capacitor native app nor the desktop app. */
const webBuild = !Capacitor.isNativePlatform() && getDesktopBridge() === null;
/**
 * The server offers guest streaming (its `GET /app-config`), as read for one
 * server URL. Only trusted while `url` is still the saved server.
 */
let guestStreaming: { url: string; on: boolean; failed: boolean } = { url: '', on: false, failed: false };
/** Latest-wins counter: an older app-config response never overwrites a newer one. */
let guestStreamingRun = 0;
/** Reads in flight: a guest call starts a re-read only when none is pending. */
let guestStreamingReads = 0;
/** The one delayed retry after a failed read (cleared by any newer read). */
let guestStreamingRetry: ReturnType<typeof setTimeout> | undefined;
/** Wait before the single automatic retry of a failed app-config read. */
const GUEST_STREAMING_RETRY_MS = 3_000;

/**
 * Reads `guestStreaming` from the server's app-config (web build only; off on
 * any failure). Called on a server change, when a guest call is rejected, and
 * on a guest call after a failed read. A transient failure is retried once
 * after a short delay; `retry` is false for that retry itself.
 */
async function refreshGuestStreaming(serverUrl: string, retry = true): Promise<void> {
  const run = ++guestStreamingRun;
  clearTimeout(guestStreamingRetry);
  guestStreamingRetry = undefined;
  let on = false;
  let failed = false;
  if (webBuild && serverUrl) {
    guestStreamingReads++;
    try {
      const res = await createDefaultTransport().request({
        method: 'GET',
        url: `${serverUrl.replace(/\/+$/, '')}/app-config`,
        headers: { accept: 'application/json' },
        timeoutMs: 10_000,
      });
      if (res.status >= 200 && res.status < 300) {
        on = (res.data as { guestStreaming?: unknown } | null)?.guestStreaming === true;
      } else {
        failed = true;
      }
    } catch {
      failed = true;
    } finally {
      guestStreamingReads--;
    }
  }
  if (run !== guestStreamingRun) return;
  guestStreaming = { url: serverUrl, on, failed };
  if (failed && retry && webBuild && serverUrl) {
    guestStreamingRetry = setTimeout(() => void refreshGuestStreaming(serverUrl, false), GUEST_STREAMING_RETRY_MS);
  }
}

/**
 * Signed-out guest streaming: web build, talking to the public server, and
 * the flag was read for the saved server URL and that server allows guests.
 * After a failed read for this server, the call starts one fresh read (it
 * answers `false` now and the next guest call uses the result).
 */
function guestStreamingAllowed(): boolean {
  const url = settings?.downloadServerUrl();
  const allowed =
    webBuild &&
    settings?.connectionMode() === 'public' &&
    guestStreaming.on &&
    guestStreaming.url === url;
  if (
    webBuild &&
    settings?.connectionMode() === 'public' &&
    guestStreaming.failed &&
    guestStreaming.url === url &&
    url &&
    guestStreamingReads === 0 &&
    guestStreamingRetry === undefined
  ) {
    void refreshGuestStreaming(url, false);
  }
  return allowed;
}

/**
 * Accounts: the build constant, else the project the download server offers
 * at `GET /app-config` (web: the same-origin server; phone: the paired one).
 */
const supabase = new SupabaseAuth(SUPABASE_BUILD_CONFIG, {
  serverUrl: async () => {
    await settingsAssigned;
    await settings?.ready();
    return settings?.downloadServerUrl() ?? '';
  },
  fetchConfig: async (serverUrl) => {
    // Read the body directly: `RemoteClient.appConfig()` drops `turnstileSiteKey`
    // (the public server's Request-access widget key).
    const res = await createDefaultTransport().request({
      method: 'GET',
      url: `${serverUrl.replace(/\/+$/, '')}/app-config`,
      headers: { accept: 'application/json' },
      timeoutMs: 10_000,
    });
    if (res.status < 200 || res.status >= 300)
      throw new Error(`Server app-config failed (${res.status}).`);
    const data = (res.data ?? {}) as {
      supabaseUrl?: unknown;
      supabaseAnonKey?: unknown;
      turnstileSiteKey?: unknown;
    };
    const url = typeof data.supabaseUrl === 'string' ? data.supabaseUrl : '';
    const anonKey = typeof data.supabaseAnonKey === 'string' ? data.supabaseAnonKey : '';
    const turnstileSiteKey =
      typeof data.turnstileSiteKey === 'string' && data.turnstileSiteKey
        ? data.turnstileSiteKey
        : undefined;
    return url && anonKey ? { url, anonKey, turnstileSiteKey } : null;
  },
});
sources.register(new CatalogProvider());
/** Imported files: a playable source and the store's file port. */
const fileStore = createDefaultFileStore();
const local = new LocalProvider(fileStore);
sources.register(local);

/**
 * Stream server client. Playback resolves a saved copy first, else a stream
 * link. Search is not a library source, so it is not registered for search.
 * Saved copies are written by `remote.streams.saveToDevice`; SettingsStore
 * configures the URL. Calls carry the signed-in user's access token (else a
 * legacy static token, if one is saved); a rejection opens the sign-in prompt.
 */
const remote = new RemoteProvider({
  lookupSavedFile: async (trackId) => {
    const saved = await storage?.importedTracks.get(trackId);
    if (!saved?.filePath || (saved.status && saved.status !== 'saved')) return undefined;
    return fileStore.url(saved.filePath);
  },
  saveBlob: (path, file) => fileStore.copyIn(path, file),
  streamQuality: () => settings?.streamQuality(),
  accessToken: () => supabase.accessToken(),
  onUnauthorized: () => auth?.promptSignIn('Sign in to search and play from the download server.'),
  guestStreaming: guestStreamingAllowed,
  // A session is known (even with a failed refresh): never a guest.
  signedIn: () => auth?.signedIn() === true,
  // A guest was rejected: the server may have turned guests off, so re-read the flag.
  onGuestRejected: () => void refreshGuestStreaming(settings?.downloadServerUrl() ?? ''),
  lookupArtist: lookupRemoteArtist,
});
sources.register(remote);

/**
 * Player sync transport. Built lazily (via `useFactory`) because `settings` and
 * `auth` are assigned by the app initializer, and `baseUrl` stays lazy so a
 * server address change is picked up without rebuilding the adapter. Never
 * connects here: `SessionStore.start()` owns that.
 */
function sessionOptions(): ServerSessionOptions & {
  accessToken: () => Promise<string | null>;
} {
  return {
    baseUrl: () => settings?.downloadServerUrl() ?? '',
    accessToken: () => auth?.accessToken() ?? Promise.resolve(null),
    refreshAccessToken: () => auth?.refreshAccessToken() ?? Promise.resolve(null),
    native: Capacitor.isNativePlatform(),
    // Public server: a session 403 `access-not-approved` shows the denied state
    // (sessions never refresh the token for it).
    onAccessDenied: () => auth?.markAccessDenied(),
  };
}

/**
 * Denied account's "Check again": `GET /ping` with the session token. `/ping`
 * is an authenticated route, so the server's approval gate answers it: `true`
 * on 2xx, `false` on the `403 access-not-approved` refusal (or any other
 * non-2xx). Throws when there is no server or session, or the request fails.
 */
async function recheckServerAccess(): Promise<boolean> {
  await settingsAssigned;
  await settings?.ready();
  const serverUrl = settings?.downloadServerUrl() ?? '';
  const token = await supabase.accessToken();
  if (!serverUrl || !token) throw new Error('No server session to check.');
  const res = await createDefaultTransport().request({
    method: 'GET',
    url: `${serverUrl.replace(/\/+$/, '')}/ping`,
    headers: { accept: 'application/json', authorization: `Bearer ${token}` },
    timeoutMs: 10_000,
  });
  return res.status >= 200 && res.status < 300;
}

/** Cast uploads and local-file reads are a browser-only feature. */
const castUploadProviders: Provider[] = Capacitor.isNativePlatform()
  ? []
  : [
      {
        provide: CastUploadPort,
        useFactory: () =>
          createCastUploads({
            ...sessionOptions(),
            clientId: () => settings?.deviceId() || 'cast-upload',
          }),
      },
      {
        provide: CastFilePort,
        useFactory: () => createCastFiles(fileStore),
      },
    ];

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideAppInitializer(() => {
      storage = inject(StoragePort);
      settings = inject(SettingsStore);
      settingsReady();
      auth = inject(AuthStore);
      // Desktop: the bridge owns the bundled server and its static token. Save
      // them before the UI can search or stream, but never block startup on a
      // broken bridge (the web build pairs with its own origin instead).
      const bridge = getDesktopBridge();
      const desktopReady = bridge
        ? connectDesktop(settings, bridge)
        : undefined;
      if (!bridge) void autoPairWeb(settings);
      // A new server address may offer a different account project.
      const store = settings;
      const accounts = auth;
      let lastUrl: string | undefined;
      effect(() => {
        if (!store.hydrated()) return;
        const url = store.downloadServerUrl();
        if (lastUrl !== undefined && url !== lastUrl) void accounts.refresh();
        if (url !== lastUrl) void refreshGuestStreaming(url);
        lastUrl = url;
      });
      return desktopReady;
    }),
    // Update checks run in the background; never awaited, so startup is not blocked.
    // A no-op on web. Each check is also gated by the user's "Check for updates" pref.
    provideAppInitializer(() => {
      inject(UpdateStore).start();
    }),
    // Route params (e.g. playlist `:id`) bind to component inputs. 'computed'
    // stamps each history entry with a page index (ɵrouterPageId) that
    // survives Back/popstate, which App uses to tell if there is an in-app
    // entry to go back to.
    provideRouter(
      appRoutes,
      withComponentInputBinding(),
      withRouterConfig({ canceledNavigationResolution: 'computed' }),
    ),
    { provide: MusicSourceRegistry, useValue: sources },
    // Web build only: Library and Playlists sit behind sign-in; native and desktop are unchanged.
    { provide: WEB_BUILD, useValue: webBuild },
    { provide: LocalMediaPort, useValue: local },
    // Spotify import: picks an Exportify .csv or data-download .json as text.
    { provide: ImportFilePort, useValue: { pickTextFile } },
    { provide: METADATA_FETCH, useValue: metadataFetch },
    { provide: RemoteServerPort, useValue: remote },
    // The public Open Record server's URL (Settings > public server switch).
    { provide: PUBLIC_SERVER, useValue: PUBLIC_SERVER_URL },
    { provide: PairingScannerPort, useValue: new PlatformPairingScanner() },
    { provide: StreamResolverPort, useValue: remote.streams },
    { provide: NetworkStatusPort, useFactory: createNetworkStatus },
    // Free space for Settings > Device storage (native plugin; null on web).
    { provide: DeviceStoragePort, useFactory: createDeviceStorage },
    // Android: foreground service so downloads continue with the screen off (null elsewhere).
    { provide: BackgroundWorkPort, useFactory: createBackgroundWork },
    // In-app updates: the Electron or Android adapter; null on web and iOS (notify only or nothing).
    { provide: UPDATE_PLATFORM, useFactory: createUpdatePlatform },
    { provide: UPDATE_APP_VERSION, useValue: APP_VERSION },
    { provide: AuthPort, useValue: supabase },
    { provide: AUTH_ACCESS_RECHECK, useValue: recheckServerAccess },
    // Library + playlist metadata sync for signed-in users (same client).
    { provide: SyncPort, useValue: new SupabaseSync(supabase) },
    // Additive per-track play counts for signed-in users (same client).
    { provide: PlayCountsPort, useValue: new SupabasePlayCounts(supabase) },
    // Your Stack (queue entries) for signed-in users (same client).
    { provide: StackSyncPort, useValue: new SupabaseStackSync(supabase) },
    // Player sync: WebSocket on the web, HTTP polling on native. Optional: the
    // stores only use it when provided, so anonymous/local mode is unchanged.
    { provide: SessionPort, useFactory: () => createSessionPort(sessionOptions()) },
    ...castUploadProviders,
    provideStorage(),
    // capacitor-plugin-playlist is installed: on device createAudioEngine()
    // uses NativeAudioEngine (foreground-service ExoPlayer, 1 Hz position
    // ticks). The HTML5 engine is the web / fallback path only.
    providePlayer({
      resolve: (track) => sources.resolve(track),
      // Imported covers for lock-screen / media-key artwork.
      resolveArt: (track) => local.artUrl(track),
      // Native: unsaved remote neighbours are left out (no stream request).
      // Web: they are resolved like playback, so the preloaded URL matches.
      resolveNeighbour: createNeighbourResolver({
        native: Capacitor.isNativePlatform(),
        remoteProviderId: REMOTE_PROVIDER_ID,
        resolve: (track) => sources.resolve(track),
        resolveSaved: (trackId) => remote.resolveSaved(trackId),
      }),
      // Busy / rate limited: stay on the track with a retry hint (no skip).
      transientError: (err) => (isBusy(err) ? remoteErrorMessage(err) : undefined),
    }),
    provideState(),
  ],
};
