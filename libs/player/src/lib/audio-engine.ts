import type { PlayableSource } from '@open-record/models';

/** What an engine needs to load one item and describe it to the OS. */
export interface EngineMedia {
  /** Track id; native adapters use it to correlate OS-driven track changes. */
  id: string;
  source: PlayableSource;
  title: string;
  artist: string;
  album?: string;
  artUrl?: string;
}

/**
 * Neighbours of the current item. Only sent to engines with
 * `wantsNeighbours`, so native players can enable lock-screen next/previous
 * and advance between tracks while the WebView is suspended.
 */
export interface EngineNeighbours {
  previous?: EngineMedia;
  next?: EngineMedia;
}

export type EngineErrorCode =
  'network' | 'decode' | 'unsupported' | 'aborted' | 'unknown';

export interface EngineError {
  code: EngineErrorCode;
  message: string;
}

export type SkipDirection = 'next' | 'previous';

/** Callbacks from an engine to its owner (the PlayerEngine). */
export interface AudioEngineListener {
  onPlaying(): void;
  onPaused(): void;
  /** Current position in seconds. */
  onTime(positionSec: number): void;
  /** Duration in seconds, once known. */
  onDuration(durationSec: number): void;
  /** The current item finished on its own. */
  onEnded(): void;
  onError(error: EngineError): void;
  /**
   * The native layer already switched to a neighbour (lock-screen skip or
   * natural advance). The owner should move its queue to match without
   * re-applying "restart if > 3s" rules.
   */
  onSkipped(direction: SkipDirection): void;
}

/**
 * Port for a single-item audio output. Queue logic lives in PlayerEngine;
 * an engine only plays what it is given.
 */
export interface AudioEngine {
  /** True when the engine drives OS media controls itself (native). */
  readonly ownsSystemControls: boolean;
  /** True when the engine wants neighbours passed to `load`. */
  readonly wantsNeighbours: boolean;
  setListener(listener: AudioEngineListener | null): void;
  /** Load (but do not start) an item. Resolves once the source is set. */
  load(media: EngineMedia, neighbours?: EngineNeighbours): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  seek(positionSec: number): Promise<void>;
  stop(): Promise<void>;
  destroy(): Promise<void>;
}

/**
 * Thrown by `AudioEngine.play()` when the platform refuses to start audio
 * without a user gesture (browser autoplay policy). Not a playback failure.
 */
export class PlaybackBlockedError extends Error {
  constructor() {
    super('Playback needs a tap to start.');
    this.name = 'PlaybackBlockedError';
  }
}
