import { Injectable, inject } from '@angular/core';
import {
  MAX_ENRICH_BATCH,
  type EnrichMatch,
  type EnrichQuery,
  type MetadataCandidate,
  type Track,
} from '@open-record/models';
import { SETTINGS_KEYS, StoragePort, type JsonValue } from '@open-record/storage';
import { LibraryStore } from './library.store';
import { RemoteServerPort } from './ports';

/** Catalogue matches at or above this confidence are applied without asking. */
export const ENRICH_AUTO_ACCEPT = 0.82;

const MAX_FIELD = 300;
const UNKNOWN_ARTIST = 'Unknown artist';

/**
 * Song-detail lookup for YouTube imports, used by `ImportStore`'s queue (it
 * is no longer a job of its own: progress, pausing and review live in the
 * import job). Asks the server for catalogue metadata (YT Music, iTunes,
 * Deezer, MusicBrainz) and applies a chosen match in place, never touching
 * fields the user edited. The original title and uploader stay in
 * `track.source`.
 */
@Injectable({ providedIn: 'root' })
export class MetadataEnrichStore {
  private readonly storage = inject(StoragePort);
  private readonly library = inject(LibraryStore);
  private readonly remote = inject(RemoteServerPort, { optional: true });

  /** The server can look up song details. */
  get available(): boolean {
    return !!this.remote?.configured && !!this.remote.enrich;
  }

  /**
   * Catalogue match (or null) per track, in order, in batches of
   * `MAX_ENRICH_BATCH`. Rejects with the provider's typed errors (busy, 429,
   * pausing errors) so the caller can wait or pause; resolves all-null when
   * the server cannot look up details.
   */
  async lookup(tracks: readonly Track[], signal?: AbortSignal): Promise<(EnrichMatch | null)[]> {
    const remote = this.remote;
    if (!remote?.configured || !remote.enrich || !tracks.length) return tracks.map(() => null);
    const out: (EnrichMatch | null)[] = [];
    for (let i = 0; i < tracks.length; i += MAX_ENRICH_BATCH) {
      const batch = tracks.slice(i, i + MAX_ENRICH_BATCH);
      const matches = await remote.enrich(batch.map(toQuery), signal);
      out.push(...batch.map((_, j) => matches[j] ?? null));
    }
    return out;
  }

  /**
   * Replace a track's metadata with a match (fields the user edited stay).
   * Saves the metadata entry and, for downloaded songs, the stored record.
   * Never marks fields as user-edited. Resolves true when changed.
   */
  async apply(id: string, match: EnrichMatch | MetadataCandidate): Promise<boolean> {
    await this.library.ready();
    const current = this.library.track(id);
    if (!current) return false;
    const next = enrichTrack(current, match);
    if (!next) return false;
    const metadata = new Set(this.library.metadataIds());
    if (metadata.has(id)) await this.library.addMetadataTracks([next]);
    const record = this.library.storedRecord(id);
    if (record) await this.library.storeRecord({ ...record, track: { ...record.track, ...pickEnriched(next) } });
    return metadata.has(id) || !!record;
  }

  /**
   * Track ids still queued by the old stand-alone lookup job (settings key
   * `youtubeImport`), which is then deleted. Used once to move them into the
   * import job.
   */
  async takeLegacyQueue(): Promise<string[]> {
    try {
      const raw = (await this.storage.settings.get<JsonValue>(SETTINGS_KEYS.youtubeImport)) as
        | { pending?: unknown }
        | undefined
        | null;
      if (raw === undefined || raw === null) return [];
      await this.storage.settings.delete(SETTINGS_KEYS.youtubeImport);
      return Array.isArray(raw.pending) ? raw.pending.filter((id): id is string => typeof id === 'string') : [];
    } catch {
      return [];
    }
  }
}

/** A catalogue match as a review suggestion (reduced fields only). */
export function toMetadataCandidate(match: EnrichMatch, id: string): MetadataCandidate {
  const c: MetadataCandidate = {
    id,
    title: match.title,
    artist: match.artist,
    score: match.confidence,
    sources: [...match.sources],
  };
  if (match.album) c.album = match.album;
  if (match.year) c.year = match.year;
  if (match.genre) c.genre = match.genre;
  if (match.artUrl) c.artUrl = match.artUrl;
  if (match.durationSec) c.durationSec = match.durationSec;
  return c;
}

/** A weak match and its server `alternatives` as review suggestions (`meta:0`, `meta:1`, ...). */
export function toMetadataCandidates(match: EnrichMatch): MetadataCandidate[] {
  return [match, ...(match.alternatives ?? [])].map((m, i) => toMetadataCandidate(m, `meta:${i}`));
}

/** The lookup sent for a track: its cleaned title and artist (uploader when unknown). */
function toQuery(track: Track): EnrichQuery {
  const artist =
    track.artist && track.artist !== UNKNOWN_ARTIST ? track.artist : (track.source?.originalArtist ?? '');
  const query: EnrichQuery = { title: track.title.slice(0, MAX_FIELD), artist: artist.slice(0, MAX_FIELD) };
  if (track.durationSec) query.durationSec = track.durationSec;
  if (track.album) query.album = track.album.slice(0, MAX_FIELD);
  return query;
}

/**
 * `track` with a match's catalogue fields (non-empty ones only; user-edited
 * fields kept), the source link untouched and the pre-enrichment title and
 * artist kept in `source`. Null when nothing would change.
 */
export function enrichTrack(
  track: Track,
  match: Pick<EnrichMatch, 'title' | 'artist' | 'album' | 'genre' | 'year' | 'artUrl'>,
): Track | null {
  const edited = new Set(track.userEdited ?? []);
  const next: Track = { ...track };
  const text = (v: string | undefined) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, MAX_FIELD) : undefined);
  const title = text(match.title);
  const artist = text(match.artist);
  const album = text(match.album);
  const genre = text(match.genre);
  if (title && !edited.has('title')) next.title = title;
  if (artist && !edited.has('artist')) next.artist = artist;
  if (album && !edited.has('album')) next.album = album;
  if (genre && !edited.has('genre')) next.genre = genre;
  if (match.year && Number.isInteger(match.year) && !edited.has('year')) next.year = match.year;
  if (match.artUrl && /^https:\/\//.test(match.artUrl)) next.artUrl = match.artUrl;
  const changed = (['title', 'artist', 'album', 'genre', 'year', 'artUrl'] as const).some((k) => next[k] !== track[k]);
  if (!changed) return null;
  if (track.source) {
    next.source = { ...track.source };
    next.source.originalTitle ??= track.title;
    if (track.artist && track.artist !== UNKNOWN_ARTIST) next.source.originalArtist ??= track.artist;
  }
  return next;
}

/** The fields enrichment may change (applied onto a stored record's track). */
function pickEnriched(t: Track): Partial<Track> {
  const out: Partial<Track> = { title: t.title, artist: t.artist };
  if (t.album !== undefined) out.album = t.album;
  if (t.genre !== undefined) out.genre = t.genre;
  if (t.year !== undefined) out.year = t.year;
  if (t.artUrl !== undefined) out.artUrl = t.artUrl;
  if (t.source) out.source = t.source;
  return out;
}
