import { DestroyRef, Injectable, InjectionToken, effect, inject, signal, untracked } from '@angular/core';
import type { Track } from '@open-record/models';
import { MusicSourceRegistry } from '@open-record/music-source';
import { Html5AudioEngine, PlaybackBlockedError } from '@open-record/player';
import type { AudioEngine } from '@open-record/player';
import { PlayerStore } from './player.store';
import { remoteErrorMessage } from './remote-errors';

/** Creates the preview's own audio engine. Overridable in tests. */
export const PREVIEW_AUDIO_ENGINE = new InjectionToken<() => AudioEngine>('PREVIEW_AUDIO_ENGINE', {
  providedIn: 'root',
  factory: () => () => new Html5AudioEngine(),
});

/**
 * Plays short previews (e.g. import review candidates) on a separate audio
 * engine, so the main queue, now playing and the persisted queue are never
 * touched. One preview at a time; starting one pauses the main player, and
 * the main player starting stops the preview.
 */
@Injectable({ providedIn: 'root' })
export class PreviewPlayerService {
  private readonly sources = inject(MusicSourceRegistry);
  private readonly player = inject(PlayerStore);
  private readonly createEngine = inject(PREVIEW_AUDIO_ENGINE);
  private engine: AudioEngine | null = null;
  /** Bumped on every start/stop so stale async work is dropped. */
  private run = 0;
  private currentId: string | null = null;
  private paused = false;

  private readonly _playingId = signal<string | null>(null);
  private readonly _loadingId = signal<string | null>(null);
  private readonly _error = signal<string | null>(null);

  /** Track id whose preview is audibly playing. */
  readonly playingId = this._playingId.asReadonly();
  /** Track id whose preview is resolving or buffering. */
  readonly loadingId = this._loadingId.asReadonly();
  /** Friendly message for the last failed preview. */
  readonly error = this._error.asReadonly();

  constructor() {
    // The main player starting (not already playing) ends the preview.
    let wasPlaying = untracked(() => this.player.isPlaying());
    effect(() => {
      const playing = this.player.isPlaying();
      if (playing && !wasPlaying && untracked(() => this.currentId)) untracked(() => void this.stop());
      wasPlaying = playing;
    });
    inject(DestroyRef).onDestroy(() => {
      this.run++;
      void this.engine?.destroy();
      this.engine = null;
    });
  }

  /** Same track pauses/resumes; another track replaces the current preview. */
  async toggle(track: Track): Promise<void> {
    if (this.currentId === track.id && this.engine) {
      if (this._loadingId() === track.id) return;
      if (this.paused) {
        await this.pauseMain();
        this.paused = false;
        await this.safePlay(this.run, track.id);
      } else {
        this.paused = true;
        await this.engine.pause().catch(() => undefined);
      }
      return;
    }
    await this.start(track);
  }

  /** Stop any preview and clear its state. Never throws. */
  async stop(): Promise<void> {
    this.run++;
    this.currentId = null;
    this.paused = false;
    this._playingId.set(null);
    this._loadingId.set(null);
    await this.engine?.stop().catch(() => undefined);
  }

  private async start(track: Track): Promise<void> {
    await this.stop();
    const run = this.run;
    this.currentId = track.id;
    this._error.set(null);
    this._loadingId.set(track.id);
    await this.pauseMain();
    try {
      const source = await this.sources.resolve(track);
      if (run !== this.run) return;
      const engine = this.ensureEngine();
      await engine.load({ id: track.id, source, title: track.title, artist: track.artist, artUrl: track.artUrl });
      if (run !== this.run) return;
      await this.safePlay(run, track.id);
    } catch (error) {
      if (run === this.run) this.fail(remoteErrorMessage(error));
    }
  }

  private async safePlay(run: number, id: string): Promise<void> {
    try {
      await this.engine?.play();
    } catch (error) {
      if (run !== this.run || this.currentId !== id) return;
      this.fail(error instanceof PlaybackBlockedError ? error.message : 'Could not play this preview.');
    }
  }

  private async pauseMain(): Promise<void> {
    if (!this.player.isPlaying()) return;
    await this.player.pause().catch(() => undefined);
  }

  private fail(message: string): void {
    void this.stop();
    this._error.set(message);
  }

  private ensureEngine(): AudioEngine {
    if (this.engine) return this.engine;
    const engine = this.createEngine();
    engine.setListener({
      onPlaying: () => {
        this.paused = false;
        this._loadingId.set(null);
        this._playingId.set(this.currentId);
      },
      onPaused: () => {
        if (!this.currentId || this._loadingId()) return;
        this.paused = true;
        this._playingId.set(null);
      },
      onTime: () => undefined,
      onDuration: () => undefined,
      onEnded: () => void this.stop(),
      onError: () => {
        if (this.currentId) this.fail('Could not play this preview.');
      },
      onSkipped: () => undefined,
    });
    this.engine = engine;
    return engine;
  }
}
