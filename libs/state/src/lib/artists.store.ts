import { Injectable, computed, inject } from '@angular/core';
import {
  albumKey,
  artistKey,
  splitArtists,
  type Track,
} from '@open-record/models';
import { LibraryStore } from './library.store';
import { PlaylistsStore } from './playlists.store';

export interface ArtistEntry {
  key: string;
  /** First-seen spelling. */
  name: string;
  /** Tracks by this artist that are saved or imported. */
  libraryTracks: Track[];
  /** Tracks by this artist that only appear in playlists. */
  playlistOnlyTracks: Track[];
  /** Albums whose primary (first credited) artist is this artist. */
  albums: AlbumEntry[];
}

export interface AlbumEntry {
  key: string;
  /** First-seen spelling. */
  title: string;
  /** Credited artists across the album's tracks, primary first. */
  artistNames: string[];
  /** Earliest known year of the album's tracks. */
  year?: number;
  tracks: Track[];
  /** First track with cover art, else the first track. */
  coverTrack: Track;
}

interface ArtistIndex {
  artists: Map<string, ArtistEntry>;
  /** Artists by name, for lists. */
  sorted: ArtistEntry[];
  albums: Map<string, AlbumEntry>;
}

/**
 * Artists and albums derived from the library (saved + imported tracks) and
 * every playlist track. Read-only: rebuilds when the library or playlists change.
 */
@Injectable({ providedIn: 'root' })
export class ArtistsStore {
  private readonly library = inject(LibraryStore);
  private readonly playlists = inject(PlaylistsStore);

  /** Saved or imported tracks, de-duplicated by id. */
  private readonly libraryTracks = computed(() =>
    dedupe([...this.library.savedRecords(), ...this.library.importedTracks()]),
  );

  /** Playlist tracks that are not in the library. */
  private readonly playlistOnlyTracks = computed(() => {
    const inLibrary = new Set(this.libraryTracks().map((t) => t.id));
    const fromPlaylists = this.playlists
      .playlists()
      .flatMap((p) => this.playlists.tracksOf(p.id));
    return dedupe(fromPlaylists).filter((t) => !inLibrary.has(t.id));
  });

  private readonly index = computed<ArtistIndex>(() =>
    buildIndex(this.libraryTracks(), this.playlistOnlyTracks()),
  );

  /** Every artist, sorted by name. */
  readonly artists = computed(() => this.index().sorted);

  /** Reactive lookup by {@link ArtistEntry.key}. */
  artist(key: string): ArtistEntry | undefined {
    return this.index().artists.get(key);
  }

  /** Reactive lookup by {@link AlbumEntry.key}. */
  album(key: string): AlbumEntry | undefined {
    return this.index().albums.get(key);
  }

  /** Every artist credited on a track (empty for unknown artists). Reactive. */
  artistsOf(track: Track): { key: string; name: string }[] {
    const artists = this.index().artists;
    return splitArtists(track.artist).map((name) => {
      const key = artistKey(name);
      return { key, name: artists.get(key)?.name ?? name };
    });
  }
}

const collator = new Intl.Collator(undefined, {
  sensitivity: 'base',
  numeric: true,
});

function dedupe(tracks: readonly Track[]): Track[] {
  const seen = new Set<string>();
  return tracks.filter((t) => {
    if (seen.has(t.id)) return false;
    seen.add(t.id);
    return true;
  });
}

function byTitle(a: Track, b: Track): number {
  return collator.compare(a.title, b.title);
}

function compareAlbums(a: AlbumEntry, b: AlbumEntry): number {
  if (a.year !== b.year) {
    if (a.year === undefined) return 1;
    if (b.year === undefined) return -1;
    return b.year - a.year;
  }
  return collator.compare(a.title, b.title);
}

function buildIndex(
  libraryTracks: readonly Track[],
  playlistOnlyTracks: readonly Track[],
): ArtistIndex {
  const artists = new Map<string, ArtistEntry>();
  const albumSources = new Map<
    string,
    { title: string; primary: string; tracks: Track[]; names: string[] }
  >();

  const entry = (name: string): ArtistEntry => {
    const key = artistKey(name);
    let found = artists.get(key);
    if (!found) {
      found = {
        key,
        name,
        libraryTracks: [],
        playlistOnlyTracks: [],
        albums: [],
      };
      artists.set(key, found);
    }
    return found;
  };

  const all: [Track, boolean][] = [
    ...libraryTracks.map((t): [Track, boolean] => [t, true]),
    ...playlistOnlyTracks.map((t): [Track, boolean] => [t, false]),
  ];
  for (const [track, inLibrary] of all) {
    const names = splitArtists(track.artist);
    for (const name of names) {
      const artist = entry(name);
      (inLibrary ? artist.libraryTracks : artist.playlistOnlyTracks).push(track);
    }

    const title = track.album?.trim();
    if (!title || !names.length) continue;
    const key = albumKey(title, names[0]);
    let source = albumSources.get(key);
    if (!source) {
      source = { title, primary: names[0], tracks: [], names: [] };
      albumSources.set(key, source);
    }
    source.tracks.push(track);
    for (const name of names) {
      if (!source.names.some((n) => artistKey(n) === artistKey(name))) {
        source.names.push(name);
      }
    }
  }

  const albums = new Map<string, AlbumEntry>();
  for (const [key, source] of albumSources) {
    const tracks = [...source.tracks].sort(byTitle);
    const years = tracks
      .map((t) => t.year)
      .filter((y): y is number => typeof y === 'number');
    const album: AlbumEntry = {
      key,
      title: source.title,
      artistNames: source.names,
      year: years.length ? Math.min(...years) : undefined,
      tracks,
      coverTrack:
        tracks.find((t) => t.artUrl || t.coverPath) ?? tracks[0],
    };
    if (album.year === undefined) delete album.year;
    albums.set(key, album);
    artists.get(artistKey(source.primary))?.albums.push(album);
  }

  for (const artist of artists.values()) {
    artist.libraryTracks.sort(byTitle);
    artist.playlistOnlyTracks.sort(byTitle);
    artist.albums.sort(compareAlbums);
  }

  const sorted = [...artists.values()].sort((a, b) =>
    collator.compare(a.name, b.name),
  );
  return { artists, sorted, albums };
}
