import {
  EnvironmentProviders,
  inject,
  makeEnvironmentProviders,
  provideAppInitializer,
} from '@angular/core';
import { AuthStore } from './auth.store';
import { AutoDownloadStore } from './auto-download.store';
import { ImportStore } from './import.store';
import { OfflineStore } from './offline.store';
import { PlayerStore } from './player.store';
import { SettingsStore } from './settings.store';
import { SyncStore } from './sync.store';

/**
 * Starts the stores at app start: hydrates library and playlists and restores
 * the saved queue (paused, at its saved position), and loads settings. Does not block bootstrap.
 * Requires `StoragePort`, `MusicSourceRegistry` and `providePlayer()`.
 */
export function provideState(): EnvironmentProviders {
  return makeEnvironmentProviders([
    provideAppInitializer(() => {
      // Hydrating settings also configures the download server.
      inject(SettingsStore);
      // Optional accounts: restores a saved session; a no-op without AuthPort.
      void inject(AuthStore).start();
      // Account sync: a no-op without SyncPort or when signed out.
      inject(SyncStore).start();
      void inject(PlayerStore).restore();
      // Registers the Spotify placeholder source; resumes a running import.
      void inject(ImportStore).restore();
      const autoDownload = inject(AutoDownloadStore);
      void inject(OfflineStore)
        .start()
        .finally(() => autoDownload.start());
    }),
  ]);
}
