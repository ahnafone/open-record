import type { Track } from '@open-record/models';

export interface MediaSessionHandlers {
  play(): void;
  pause(): void;
  next(): void;
  previous(): void;
  seekTo(positionSec: number): void;
}

/** Default skip used for OS seek-forward / seek-backward buttons. */
const SEEK_STEP_SEC = 10;

function guessImageType(url: string): string | undefined {
  const ext = /\.(png|jpe?g|webp|gif|svg)(?:[?#]|$)/i
    .exec(url)?.[1]
    ?.toLowerCase();
  if (!ext) return undefined;
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'svg') return 'image/svg+xml';
  return `image/${ext}`;
}

/**
 * Thin wrapper over `navigator.mediaSession` (web fallback for lock-screen,
 * notification and hardware media keys). Every call is a no-op when the API
 * is missing, and individual actions the browser rejects are skipped.
 */
export class MediaSessionController {
  private readonly session: MediaSession | null;
  private handlers: MediaSessionHandlers | null = null;
  private position = 0;

  constructor(
    session: MediaSession | null = typeof navigator !== 'undefined' &&
    'mediaSession' in navigator
      ? navigator.mediaSession
      : null,
  ) {
    this.session = session;
  }

  get supported(): boolean {
    return this.session !== null;
  }

  setHandlers(handlers: MediaSessionHandlers | null): void {
    this.handlers = handlers;
    const h = handlers;
    this.action('play', h && (() => h.play()));
    this.action('pause', h && (() => h.pause()));
    this.action('nexttrack', h && (() => h.next()));
    this.action('previoustrack', h && (() => h.previous()));
    this.action(
      'seekto',
      h &&
        ((d) => {
          if (d.seekTime !== undefined && d.seekTime !== null)
            h.seekTo(d.seekTime);
        }),
    );
    this.action(
      'seekforward',
      h && ((d) => h.seekTo(this.position + (d.seekOffset ?? SEEK_STEP_SEC))),
    );
    this.action(
      'seekbackward',
      h &&
        ((d) =>
          h.seekTo(
            Math.max(0, this.position - (d.seekOffset ?? SEEK_STEP_SEC)),
          )),
    );
  }

  /**
   * Show or hide "next" depending on queue position. "Previous" always stays,
   * since it also restarts the current track.
   */
  setNextAvailable(hasNext: boolean): void {
    const h = this.handlers;
    if (!h) return;
    this.action('nexttrack', hasNext ? () => h.next() : null);
  }

  /** `artUrl` overrides `track.artUrl` (e.g. a resolved imported cover). */
  setMetadata(track: Track | null, artUrl = track?.artUrl): void {
    if (!this.session) return;
    if (!track || typeof MediaMetadata === 'undefined') {
      this.session.metadata = null;
      return;
    }
    const type = artUrl ? guessImageType(artUrl) : undefined;
    this.session.metadata = new MediaMetadata({
      title: track.title,
      artist: track.artist,
      artwork: artUrl
        ? [{ src: artUrl, sizes: '512x512', ...(type ? { type } : {}) }]
        : [],
    });
  }

  setPlaybackState(state: MediaSessionPlaybackState): void {
    if (this.session) this.session.playbackState = state;
  }

  setPosition(positionSec: number, durationSec: number): void {
    this.position = positionSec;
    if (!this.session?.setPositionState) return;
    try {
      if (!(durationSec > 0) || !Number.isFinite(durationSec)) {
        this.session.setPositionState();
        return;
      }
      this.session.setPositionState({
        duration: durationSec,
        position: Math.min(Math.max(0, positionSec), durationSec),
        playbackRate: 1,
      });
    } catch {
      // Some browsers reject transient states (e.g. during a source swap).
    }
  }

  clear(): void {
    this.setHandlers(null);
    this.setMetadata(null);
    this.setPlaybackState('none');
    this.setPosition(0, 0);
  }

  private action(
    name: MediaSessionAction,
    fn: MediaSessionActionHandler | null,
  ): void {
    try {
      this.session?.setActionHandler(name, fn);
    } catch {
      // Action not supported by this browser.
    }
  }
}
