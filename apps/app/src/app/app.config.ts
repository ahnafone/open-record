import {
  ApplicationConfig,
  provideBrowserGlobalErrorListeners,
} from '@angular/core';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { MusicSourceRegistry } from '@open-record/music-source';
import { providePlayer } from '@open-record/player';
import { CatalogProvider } from '@open-record/providers/catalog';
import { LocalProvider } from '@open-record/providers/local';
import { RemoteProvider } from '@open-record/providers/remote';
import {
  LocalMediaPort,
  RemoteDownloadPort,
  provideState,
} from '@open-record/state';
import { provideStorage } from '@open-record/storage';
import { appRoutes } from './app.routes';

/** Music sources registered at startup; the UI never sees a concrete provider. */
const sources = new MusicSourceRegistry();
sources.register(new CatalogProvider());
/** Imported files: a playable source and the store's file port. */
const local = new LocalProvider();
sources.register(local);
/**
 * Download server client. Not registered in the registry: library search
 * would otherwise hit the server. Finished files go through the local import
 * pipeline; SettingsStore configures the URL + token.
 */
const remote = new RemoteProvider({
  importer: (file, extras) => local.importDownloaded(file, extras),
});

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    // Route params (e.g. playlist `:id`) bind to component inputs.
    provideRouter(appRoutes, withComponentInputBinding()),
    { provide: MusicSourceRegistry, useValue: sources },
    { provide: LocalMediaPort, useValue: local },
    { provide: RemoteDownloadPort, useValue: remote },
    provideStorage(),
    // capacitor-plugin-playlist is not installed (iOS 18 target pending), so
    // createAudioEngine() falls back to the HTML5 engine on every platform.
    providePlayer({
      resolve: (track) => sources.resolve(track),
      // Imported covers for lock-screen / media-key artwork.
      resolveArt: (track) => local.artUrl(track),
    }),
    provideState(),
  ],
};
