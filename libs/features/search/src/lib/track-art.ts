import { inject } from '@angular/core';
import type { Track } from '@open-record/models';
import { LibraryStore } from '@open-record/state';
import type { SleeveSrc } from '@open-record/ui';

/**
 * Sleeve art for a track, resolved at display time: the provider's `artUrl`,
 * else the stored cover of an imported track (a promise, memoized per track
 * object so templates can call it freely). No art gives the disc fallback.
 * Call in an injection context.
 */
export function injectTrackArt(): (
  track: Track | null | undefined,
) => SleeveSrc {
  const library = inject(LibraryStore);
  const cache = new WeakMap<Track, Promise<string | undefined>>();
  return (track) => {
    if (!track) return null;
    if (track.artUrl || !track.coverPath) return track.artUrl;
    let art = cache.get(track);
    if (!art) {
      art = library.artUrl(track).catch(() => undefined);
      cache.set(track, art);
    }
    return art;
  };
}
