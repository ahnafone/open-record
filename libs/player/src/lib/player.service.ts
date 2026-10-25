import {
  DestroyRef,
  Injectable,
  InjectionToken,
  effect,
  inject,
} from '@angular/core';
import type { EnvironmentProviders, Provider } from '@angular/core';
import { makeEnvironmentProviders } from '@angular/core';
import type { AudioEngine } from './audio-engine';
import { Html5AudioEngine } from './html5-audio-engine';
import { MediaSessionController } from './media-session';
import { NativeAudioEngine } from './native-audio-engine';
import { PlayerEngine } from './player-engine';
import type { PlayerEngineOptions, TrackResolver } from './player-engine';

/**
 * Turns a Track into a PlayableSource. Supplied by the app (typically the
 * music-source registry); the player never depends on music-source itself.
 */
export const TRACK_RESOLVER = new InjectionToken<TrackResolver>(
  'TRACK_RESOLVER',
);

export const PLAYER_ENGINE_OPTIONS = new InjectionToken<PlayerEngineOptions>(
  'PLAYER_ENGINE_OPTIONS',
  { providedIn: 'root', factory: () => ({}) },
);

/** Native engine on device when the plugin is installed, else HTML5 audio. */
export function createAudioEngine(): AudioEngine {
  return NativeAudioEngine.isAvailable()
    ? new NativeAudioEngine()
    : new Html5AudioEngine();
}

export const AUDIO_ENGINE = new InjectionToken<AudioEngine>('AUDIO_ENGINE', {
  providedIn: 'root',
  factory: createAudioEngine,
});

export interface ProvidePlayerConfig extends PlayerEngineOptions {
  resolve: TrackResolver;
}

export function providePlayer(
  config: ProvidePlayerConfig,
): EnvironmentProviders {
  const { resolve, ...options } = config;
  const providers: Provider[] = [
    { provide: TRACK_RESOLVER, useValue: resolve },
    { provide: PLAYER_ENGINE_OPTIONS, useValue: options },
  ];
  return makeEnvironmentProviders(providers);
}

/**
 * App-wide player: owns the PlayerEngine and mirrors its state into the
 * browser Media Session when the engine does not drive OS controls itself.
 */
@Injectable({ providedIn: 'root' })
export class PlayerService {
  private readonly audio = inject(AUDIO_ENGINE);
  readonly engine = new PlayerEngine(
    this.audio,
    inject(TRACK_RESOLVER),
    inject(PLAYER_ENGINE_OPTIONS),
  );

  constructor() {
    if (!this.audio.ownsSystemControls) this.bindMediaSession();
    inject(DestroyRef).onDestroy(() => void this.engine.destroy());
  }

  private bindMediaSession(): void {
    const session = new MediaSessionController();
    if (!session.supported) return;
    const e = this.engine;
    session.setHandlers({
      play: () => void e.play(),
      pause: () => void e.pause(),
      next: () => void e.next(),
      previous: () => void e.previous(),
      seekTo: (sec) => void e.seek(sec),
    });
    effect(() => {
      const track = e.current();
      session.setMetadata(track);
      if (!track || track.artUrl) return;
      // Imported covers resolve asynchronously; ignore stale results.
      void e.resolveArt(track).then((url) => {
        if (url && e.current() === track) session.setMetadata(track, url);
      });
    });
    effect(() => session.setNextAvailable(e.hasNext()));
    effect(() => {
      const status = e.status();
      session.setPlaybackState(
        status === 'playing'
          ? 'playing'
          : status === 'idle'
            ? 'none'
            : 'paused',
      );
    });
    effect(() => session.setPosition(e.position(), e.duration()));
    inject(DestroyRef).onDestroy(() => session.clear());
  }
}
