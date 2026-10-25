import {
  EnvironmentProviders,
  inject,
  makeEnvironmentProviders,
  provideAppInitializer,
} from '@angular/core';
import { PlayerStore } from './player.store';

/**
 * Starts the stores at app start: hydrates library and playlists and restores
 * the saved queue (paused, at its saved position). Does not block bootstrap.
 * Requires `StoragePort`, `MusicSourceRegistry` and `providePlayer()`.
 */
export function provideState(): EnvironmentProviders {
  return makeEnvironmentProviders([
    provideAppInitializer(() => {
      void inject(PlayerStore).restore();
    }),
  ]);
}
