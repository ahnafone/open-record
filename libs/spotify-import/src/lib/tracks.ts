import { normalizeArtist, normalizeTitle, primaryArtist } from '@open-record/metadata-lookup';
import type { ImportedTrack } from './types';

/** Track id from `spotify:track:<id>` or `https://open.spotify.com/track/<id>`; undefined otherwise (local files, episodes). */
export function spotifyIdFromUri(uri: string | undefined | null): string | undefined {
  if (!uri) return undefined;
  const m = /(?:^spotify:track:|open\.spotify\.com\/(?:[\w-]+\/)?track\/)([A-Za-z0-9]{22})\b/.exec(uri.trim());
  return m?.[1];
}

/** Splits an artist list on ";" when present, else on ",". */
export function splitArtists(raw: string | undefined | null): string[] {
  const s = (raw ?? '').trim();
  if (!s) return [];
  const parts = s.includes(';') ? s.split(';') : s.split(',');
  return parts.map((p) => p.trim()).filter(Boolean);
}

function clean(s: unknown): string | undefined {
  return typeof s === 'string' && s.trim() ? s.trim() : undefined;
}

/** Builds an ImportedTrack, or null when there is no title. */
export function makeTrack(fields: {
  title: unknown;
  artists: string[];
  album?: unknown;
  durationMs?: unknown;
  isrc?: unknown;
  uri?: unknown;
  addedAt?: unknown;
}): ImportedTrack | null {
  const title = clean(fields.title);
  if (!title) return null;
  const artists = fields.artists.map((a) => a.trim()).filter(Boolean);
  const track: ImportedTrack = { title, artists, artist: artists.join(', ') };
  const album = clean(fields.album);
  if (album) track.album = album;
  const ms = Number(fields.durationMs);
  if (fields.durationMs !== undefined && fields.durationMs !== '' && Number.isFinite(ms) && ms > 0) {
    track.durationMs = Math.round(ms);
  }
  const isrc = clean(fields.isrc)?.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (isrc) track.isrc = isrc;
  const spotifyId = spotifyIdFromUri(clean(fields.uri));
  if (spotifyId) track.spotifyId = spotifyId;
  const addedAt = clean(fields.addedAt);
  if (addedAt) track.addedAt = addedAt;
  return track;
}

/** Identity used for dedupe: ISRC, else Spotify id, else normalised title + primary artist. */
export function trackKey(t: ImportedTrack): string {
  if (t.isrc) return `isrc:${t.isrc}`;
  if (t.spotifyId) return `sp:${t.spotifyId}`;
  return `meta:${normalizeTitle(t.title)}|${primaryArtist(normalizeArtist(t.artists[0] ?? t.artist))}`;
}

/**
 * Drops repeats (first occurrence wins). Two tracks are the same when they
 * share an ISRC or a Spotify id; tracks with neither compare by normalised
 * title + primary artist.
 */
export function dedupeTracks(tracks: readonly ImportedTrack[]): ImportedTrack[] {
  const seen = new Set<string>();
  return tracks.filter((t) => {
    const keys = [t.isrc && `isrc:${t.isrc}`, t.spotifyId && `sp:${t.spotifyId}`].filter(
      (k): k is string => !!k,
    );
    if (!keys.length) keys.push(trackKey(t));
    if (keys.some((k) => seen.has(k))) return false;
    for (const k of keys) seen.add(k);
    return true;
  });
}
