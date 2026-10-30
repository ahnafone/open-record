import { Injectable, signal } from '@angular/core';
import type { Track } from '@open-record/models';

/**
 * The record whose source is being repaired. The shell owns the dialog; a
 * screen opens it with the failing track and closes it when done.
 */
@Injectable({ providedIn: 'root' })
export class SourceFixService {
  readonly track = signal<Track | null>(null);

  open(track: Track): void {
    this.track.set(track);
  }

  close(): void {
    this.track.set(null);
  }
}
