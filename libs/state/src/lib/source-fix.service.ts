import { Injectable, signal } from '@angular/core';
import type { Track } from '@open-record/models';

/**
 * The record whose source is being repaired. The shell owns the dialog; a
 * screen opens it with the failing track and closes it when done.
 */
@Injectable({ providedIn: 'root' })
export class SourceFixService {
  readonly track = signal<Track | null>(null);
  /** Element to send focus back to when the dialog closes. */
  readonly returnFocus = signal<HTMLElement | null>(null);

  open(track: Track, returnFocus?: HTMLElement): void {
    this.track.set(track);
    this.returnFocus.set(returnFocus ?? null);
  }

  close(): void {
    this.track.set(null);
    this.returnFocus.set(null);
  }
}
