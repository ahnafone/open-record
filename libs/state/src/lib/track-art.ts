import { Injectable, inject } from '@angular/core';
import type { Track } from '@open-record/models';
import { LibraryStore } from './library.store';

/**
 * Sleeve art for a track, resolved at display time: the provider's `artUrl`,
 * else the stored cover of an imported track (a promise, memoized per track
 * object so templates can call it freely). No art gives the disc fallback.
 * One app-wide cache, so every card and row showing a track shares a
 * resolution.
 */
@Injectable({ providedIn: 'root' })
export class TrackArtService {
  private readonly library = inject(LibraryStore);
  private readonly cache = new WeakMap<Track, Promise<string | undefined>>();

  /** A value for `<or-sleeve [src]>`: a URL, a promise of one, or nothing. */
  art(
    track: Track | null | undefined,
  ): string | Promise<string | undefined> | null | undefined {
    if (!track) return null;
    if (track.artUrl || !track.coverPath) return track.artUrl;
    let art = this.cache.get(track);
    if (!art) {
      art = this.library.artUrl(track).catch(() => undefined);
      this.cache.set(track, art);
    }
    return art;
  }
}
