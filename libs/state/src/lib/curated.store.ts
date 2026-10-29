import { Injectable, inject } from '@angular/core';
import type { Track } from '@open-record/models';
import { LibraryStore } from './library.store';
import { PlayCountsStore } from './play-counts.store';

export const RECENTLY_PLAYED_ID = 'recently-played';

/** An app-curated, playlist-like list that the user cannot edit. */
export interface CuratedPlaylist {
  readonly id: string;
  readonly name: string;
  readonly description: string;
}

/** App-curated lists, in sidebar order. */
const PLAYLISTS: readonly CuratedPlaylist[] = [
  {
    id: RECENTLY_PLAYED_ID,
    name: 'Recently Played',
    description: 'Records you have played recently, newest first.',
  },
];

/**
 * App-curated, playlist-like lists, starting with "Recently Played". They are
 * derived from records the app already keeps (play counts plus the library),
 * so they need no storage of their own and cannot be edited by the user.
 * Shaped so future lists (Weekly Mix, Discover Weekly) can join {@link playlists}.
 */
@Injectable({ providedIn: 'root' })
export class CuratedStore {
  private readonly playCounts = inject(PlayCountsStore);
  private readonly library = inject(LibraryStore);

  /** Ordered list for the sidebar. */
  readonly playlists = PLAYLISTS;

  /** Reactive lookup; undefined for unknown ids. */
  playlist(id: string): CuratedPlaylist | undefined {
    return this.playlists.find((p) => p.id === id);
  }

  /** Playable rows, most recently played first. Unknown lists are empty. */
  entriesOf(id: string): readonly { track: Track; lastPlayedAt: number }[] {
    if (id !== RECENTLY_PLAYED_ID) return [];
    const known = this.library.trackMap();
    return this.playCounts.recentlyPlayed().flatMap((record) => {
      // A record without a snapshot can still resolve through the library.
      const track = record.track ?? known.get(record.trackId);
      return track ? [{ track, lastPlayedAt: record.lastPlayedAt }] : [];
    });
  }

  /** When the track was last played in the list, if it is there (epoch ms). */
  lastPlayedAtOf(id: string, trackId: string): number | undefined {
    return this.entriesOf(id).find((e) => e.track.id === trackId)?.lastPlayedAt;
  }

  /** Number of playable rows in the list. */
  totalOf(id: string): number {
    return this.entriesOf(id).length;
  }

  /** Resolves once the play-count data is hydrated. */
  async ready(): Promise<void> {
    await Promise.all([this.playCounts.ready(), this.library.ready()]);
  }
}
