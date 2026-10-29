import {
  ApplicationConfig,
  effect,
  inject,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
} from '@angular/core';
import { provideRouter, withComponentInputBinding, withRouterConfig } from '@angular/router';
import { MusicSourceRegistry } from '@open-record/music-source';
import { providePlayer } from '@open-record/player';
import { CatalogProvider } from '@open-record/providers/catalog';
import { LocalProvider, createDefaultFileStore, pickTextFile } from '@open-record/providers/local';
import {
  REMOTE_PROVIDER_ID,
  RemoteClient,
  RemoteProvider,
  createDefaultTransport,
} from '@open-record/providers/remote';
import {
  AuthPort,
  AuthStore,
  BackgroundWorkPort,
  DeviceStoragePort,
  ImportFilePort,
  LocalMediaPort,
  METADATA_FETCH,
  NetworkStatusPort,
  PairingScannerPort,
  PlayCountsPort,
  RemoteServerPort,
  SettingsStore,
  StreamResolverPort,
  SyncPort,
  isBusy,
  provideState,
  remoteErrorMessage,
} from '@open-record/state';
import { StoragePort, provideStorage } from '@open-record/storage';
import { appRoutes } from './app.routes';
import { createBackgroundWork } from './background-work';
import { createDeviceStorage } from './device-storage';
import { lookupRemoteArtist, metadataFetch } from './metadata-fetch';
import { createNetworkStatus } from './network-status';
import { PlatformPairingScanner } from './pairing-scanner';
import { SupabaseAuth } from './supabase-auth';
import { SupabasePlayCounts } from './supabase-play-counts';
import { SupabaseSync } from './supabase-sync';
import { SUPABASE_BUILD_CONFIG } from './supabase.config';
import { autoPairWeb } from './web-pairing';

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
    const config = await new RemoteClient({ baseUrl: serverUrl }, createDefaultTransport()).appConfig();
    return config.supabaseUrl && config.supabaseAnonKey
      ? { url: config.supabaseUrl, anonKey: config.supabaseAnonKey }
      : null;
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
  lookupArtist: lookupRemoteArtist,
});
sources.register(remote);

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideAppInitializer(() => {
      storage = inject(StoragePort);
      settings = inject(SettingsStore);
      settingsReady();
      auth = inject(AuthStore);
      // Web build served by the download server: use it (not awaited).
      void autoPairWeb(settings);
      // A new server address may offer a different account project.
      const store = settings;
      const accounts = auth;
      let lastUrl: string | undefined;
      effect(() => {
        if (!store.hydrated()) return;
        const url = store.downloadServerUrl();
        if (lastUrl !== undefined && url !== lastUrl) void accounts.refresh();
        lastUrl = url;
      });
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
    { provide: LocalMediaPort, useValue: local },
    // Spotify import: picks an Exportify .csv or data-download .json as text.
    { provide: ImportFilePort, useValue: { pickTextFile } },
    { provide: METADATA_FETCH, useValue: metadataFetch },
    { provide: RemoteServerPort, useValue: remote },
    { provide: PairingScannerPort, useValue: new PlatformPairingScanner() },
    { provide: StreamResolverPort, useValue: remote.streams },
    { provide: NetworkStatusPort, useFactory: createNetworkStatus },
    // Free space for Settings > Device storage (native plugin; null on web).
    { provide: DeviceStoragePort, useFactory: createDeviceStorage },
    // Android: foreground service so downloads continue with the screen off (null elsewhere).
    { provide: BackgroundWorkPort, useFactory: createBackgroundWork },
    { provide: AuthPort, useValue: supabase },
    // Library + playlist metadata sync for signed-in users (same client).
    { provide: SyncPort, useValue: new SupabaseSync(supabase) },
    // Additive per-track play counts for signed-in users (same client).
    { provide: PlayCountsPort, useValue: new SupabasePlayCounts(supabase) },
    provideStorage(),
    // capacitor-plugin-playlist is installed: on device createAudioEngine()
    // uses NativeAudioEngine (foreground-service ExoPlayer, 1 Hz position
    // ticks). The HTML5 engine is the web / fallback path only.
    providePlayer({
      resolve: (track) => sources.resolve(track),
      // Imported covers for lock-screen / media-key artwork.
      resolveArt: (track) => local.artUrl(track),
      // Neighbours are pre-resolved only when playable without a server call:
      // unsaved remote tracks are left out (no stream request for them).
      resolveNeighbour: (track) =>
        track.providerId === REMOTE_PROVIDER_ID
          ? remote.resolveSaved(track.id)
          : sources.resolve(track),
      // Busy / rate limited: stay on the track with a retry hint (no skip).
      transientError: (err) => (isBusy(err) ? remoteErrorMessage(err) : undefined),
    }),
    provideState(),
  ],
};
