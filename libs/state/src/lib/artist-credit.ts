import { Pipe, type PipeTransform } from '@angular/core';
import { albumKey, artistKey, splitArtists } from '@open-record/models';

/**
 * One name in a credit. `commands` is a router command array such as
 * `['/artist', key]` (passed to `routerLink` as-is, never as a URL string);
 * `null` renders plain text.
 */
export interface CreditLink {
  readonly name: string;
  readonly commands: string[] | null;
}

/** Artist and album links for `<or-artist-links [credit]>`. */
export interface ArtistCredit {
  readonly artists: readonly CreditLink[];
  readonly album: CreditLink | null;
}

const UNKNOWN_KEY = artistKey('Unknown artist');

/** A key that can route: non-empty and not "Unknown artist". */
const isLinkableKey = (key: string): boolean =>
  key !== '' && key !== UNKNOWN_KEY;

/** Links one artist to `['/artist', key]`; an empty key or unknown artist stays plain. */
function artistLink(name: string): CreditLink {
  const key = artistKey(name);
  return { name, commands: isLinkableKey(key) ? ['/artist', key] : null };
}

/** Links the album to `['/album', key]` keyed by the primary artist, when that is linkable. */
function albumLink(
  album: string | null | undefined,
  primary: string | null,
): CreditLink | null {
  const title = album?.trim() ?? '';
  if (!title) return null;
  const linkable =
    primary !== null &&
    isLinkableKey(artistKey(primary)) &&
    artistKey(title) !== '';
  return {
    name: title,
    commands: linkable ? ['/album', albumKey(title, primary)] : null,
  };
}

/**
 * Credit from artist names that are already split (for example an album's
 * `artistNames`). Each name links to its artist page; the album, when given,
 * links to its album page keyed by the first name.
 */
export function creditFromNames(
  names: readonly string[],
  album?: string | null,
): ArtistCredit {
  const artists = names
    .map((name) => name.trim())
    .filter((name) => name !== '')
    .map(artistLink);
  return {
    artists,
    album: albumLink(album, artists[0]?.name ?? null),
  };
}

/**
 * Builds the artist / album links for a track credit. The credit is split with
 * `splitArtists`, so "Unknown artist", an empty credit or a separator-only
 * credit stay plain text (the raw credit is shown, nothing links).
 */
export function artistCredit(
  artist: string,
  album?: string | null,
): ArtistCredit {
  const credit = artist.trim();
  const split = splitArtists(credit);
  if (split.length) return creditFromNames(split, album);
  return {
    artists: credit ? [{ name: credit, commands: null }] : [],
    album: albumLink(album, null),
  };
}

/** Pure pipe: `{{ track.artist | artistCredit: track.album }}`. */
@Pipe({ name: 'artistCredit', pure: true })
export class ArtistCreditPipe implements PipeTransform {
  transform(artist: string, album?: string | null): ArtistCredit {
    return artistCredit(artist, album);
  }
}
