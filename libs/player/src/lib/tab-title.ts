import type { Track } from '@open-record/models';
import type { PlayerStatus } from './player-engine';

export const APP_TITLE = 'Open Record';

const SEPARATOR = ' | ';
const DASH = ' – ';

/**
 * Document title for the current track, e.g. `▶ Song – Artist | Open Record`.
 * Returns `null` when there is nothing to show (idle, no track or no title).
 */
export function formatTabTitle(
  track: Track | null,
  status: PlayerStatus,
  appTitle = APP_TITLE,
): string | null {
  const title = track?.title?.trim();
  if (!track || !title || status === 'idle') return null;
  const icon = status === 'playing' || status === 'loading' ? '▶' : '⏸';
  const artist = track.artist?.trim();
  const name = artist ? `${title}${DASH}${artist}` : title;
  return `${icon} ${name}${SEPARATOR}${appTitle}`;
}

/**
 * Shows the now-playing track in the browser tab title. While a track is
 * shown, the title element is watched: a route-specific title set meanwhile
 * is replaced again and kept as the title to restore. Every method is a
 * no-op without a document (SSR).
 */
export class TabTitleController {
  private original: string | null = null;
  private observer: MutationObserver | null = null;
  private current: string | null = null;

  constructor(
    private readonly doc: Document | null = typeof document !== 'undefined'
      ? document
      : null,
  ) {}

  /** Show the track, or restore the original title when there is nothing to show. */
  update(track: Track | null, status: PlayerStatus): void {
    const title = formatTabTitle(track, status);
    if (!title) {
      this.restore();
      return;
    }
    this.captureOriginal();
    this.current = title;
    this.apply();
    this.observe();
  }

  /** Put back the title captured before the track was shown. */
  restore(): void {
    this.disconnect();
    if (!this.doc || this.current === null) return;
    this.current = null;
    this.doc.title = this.original || APP_TITLE;
    // Re-capture on the next track so a later route title is not stale.
    this.original = null;
  }

  destroy(): void {
    this.restore();
  }

  private captureOriginal(): void {
    if (this.original === null && this.doc) this.original = this.doc.title;
  }

  private apply(): void {
    if (this.doc && this.current !== null && this.doc.title !== this.current)
      this.doc.title = this.current;
  }

  private observe(): void {
    if (
      this.observer ||
      !this.doc?.head ||
      typeof MutationObserver === 'undefined'
    )
      return;
    this.observer = new MutationObserver(() => {
      if (!this.doc || this.current === null || this.doc.title === this.current)
        return;
      // A route set its own title while a track is shown: keep it for restore.
      this.original = this.doc.title;
      this.apply();
    });
    this.observer.observe(this.doc.head, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  private disconnect(): void {
    this.observer?.disconnect();
    this.observer = null;
  }
}
