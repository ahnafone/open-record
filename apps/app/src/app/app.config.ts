import {
  ApplicationConfig,
  inject,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
} from '@angular/core';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { MusicSourceRegistry } from '@open-record/music-source';
import { providePlayer } from '@open-record/player';
import { CatalogProvider } from '@open-record/providers/catalog';
import { LocalProvider, createDefaultFileStore, pickTextFile } from '@open-record/providers/local';
import { REMOTE_PROVIDER_ID, RemoteProvider } from '@open-record/providers/remote';
import {
  AuthPort,
  ImportFilePort,
  LocalMediaPort,
  METADATA_FETCH,
  NetworkStatusPort,
  PairingScannerPort,
  RemoteServerPort,
  SettingsStore,
  StreamResolverPort,
  provideState,
} from '@open-record/state';
import { StoragePort, provideStorage } from '@open-record/storage';
import { appRoutes } from './app.routes';
import { metadataFetch } from './metadata-fetch';
import { createNetworkStatus } from './network-status';
import { PlatformPairingScanner } from './pairing-scanner';
import { SupabaseAuth } from './supabase-auth';
import { SUPABASE_BUILD_CONFIG } from './supabase.config';

/** Music sources registered at startup; the UI never sees a concrete provider. */
const sources = new MusicSourceRegistry();
sources.register(new CatalogProvider());
/** Imported files: a playable source and the store's file port. */
const fileStore = createDefaultFileStore();
const local = new LocalProvider(fileStore);
sources.register(local);

/**
 * Storage is injected at app start (see `provideAppInitializer`); the remote
 * provider is built before that, so it reads the saved-file record lazily.
 */
let storage: StoragePort | undefined;
/** Read lazily for the streaming quality (set at app start, like `storage`). */
let settings: SettingsStore | undefined;

/**
 * Stream server client. Playback resolves a saved copy first, else a stream
 * link. Search is not a library source, so it is not registered for search.
 * Saved copies are written by `remote.streams.saveToDevice`; SettingsStore
 * configures the URL + token.
 */
const remote = new RemoteProvider({
  lookupSavedFile: async (trackId) => {
    const saved = await storage?.importedTracks.get(trackId);
    if (!saved?.filePath || (saved.status && saved.status !== 'saved')) return undefined;
    return fileStore.url(saved.filePath);
  },
  saveBlob: (path, file) => fileStore.copyIn(path, file),
  streamQuality: () => settings?.streamQuality(),
});
sources.register(remote);

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideAppInitializer(() => {
      storage = inject(StoragePort);
      settings = inject(SettingsStore);
    }),
    // Route params (e.g. playlist `:id`) bind to component inputs.
    provideRouter(appRoutes, withComponentInputBinding()),
    { provide: MusicSourceRegistry, useValue: sources },
    { provide: LocalMediaPort, useValue: local },
    // Spotify import: picks an Exportify .csv or data-download .json as text.
    { provide: ImportFilePort, useValue: { pickTextFile } },
    { provide: METADATA_FETCH, useValue: metadataFetch },
    { provide: RemoteServerPort, useValue: remote },
    { provide: PairingScannerPort, useValue: new PlatformPairingScanner() },
    { provide: StreamResolverPort, useValue: remote.streams },
    { provide: NetworkStatusPort, useFactory: createNetworkStatus },
    // Optional accounts; inert until a Supabase project is set (here or in Settings).
    { provide: AuthPort, useValue: new SupabaseAuth(SUPABASE_BUILD_CONFIG) },
    provideStorage(),
    // capacitor-plugin-playlist is not installed (iOS 18 target pending), so
    // createAudioEngine() falls back to the HTML5 engine on every platform.
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
    }),
    provideState(),
  ],
};
