import {
  EnvironmentProviders,
  inject,
  makeEnvironmentProviders,
  provideAppInitializer,
} from '@angular/core';
import { OfflineStore } from './offline.store';
import { PlayerStore } from './player.store';
import { SettingsStore } from './settings.store';

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
      void inject(PlayerStore).restore();
      void inject(OfflineStore).start();
    }),
  ]);
}
