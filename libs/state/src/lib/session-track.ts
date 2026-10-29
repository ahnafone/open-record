import type { SessionTrack, Track } from '@open-record/models';
import { LOCAL_PROVIDER_ID } from './library.store';

/** Platforms the session device list knows about (cast rows are server-made). */
export type SessionPlatform = 'android' | 'ios' | 'web';

/**
 * The platform this client presents itself as. Prefers the Capacitor global
 * (set by the native shell) and falls back to the user agent, so the state lib
 * stays free of a hard dependency on `@capacitor/core`.
 */
export function detectPlatform(): SessionPlatform {
  const capacitor = (
    globalThis as {
      Capacitor?: { getPlatform?: () => string };
    }
  ).Capacitor;
  const platform = capacitor?.getPlatform?.();
  if (platform === 'android' || platform === 'ios') return platform;
  if (platform === 'web') return 'web';

  const userAgent = globalThis.navigator?.userAgent ?? '';
  if (/android/i.test(userAgent)) return 'android';
  if (/iphone|ipad|ipod/i.test(userAgent)) return 'ios';
  return 'web';
}

/**
 * Map a local `Track` to the session wire shape. Deliberately drops local
 * paths (`sourceFile`, `coverPath`) and keeps only what another device needs
 * to render and resolve the entry: `source`, `catalogFile` and `uploadId`.
 * The `entryId` identifies this queue entry, not the song.
 */
export function toSessionTrack(track: Track, entryId: string): SessionTrack {
  const wire: SessionTrack = {
    entryId,
    id: track.id,
    providerId: track.providerId,
    title: track.title,
    artist: track.artist,
  };
  if (track.album !== undefined) wire.album = track.album;
  if (track.durationSec !== undefined) wire.durationSec = track.durationSec;
  if (track.artUrl !== undefined) wire.artUrl = track.artUrl;
  if (track.source) {
    wire.source = {
      site: track.source.site,
      url: track.source.url,
    };
    if (track.source.id !== undefined) wire.source.id = track.source.id;
  }
  if (track.catalogFile !== undefined) wire.catalogFile = track.catalogFile;
  if (track.providerId === LOCAL_PROVIDER_ID) wire.local = true;
  return wire;
}

/**
 * Map a wire entry back to a `Track` with metadata only. A `local: true` entry
 * is rehydrated from `LibraryStore` by `SessionStore` when this device has it;
 * this is the fallback for entries it does not.
 */
export function fromSessionTrack(entry: SessionTrack): Track {
  const track: Track = {
    id: entry.id,
    providerId: entry.providerId,
    title: entry.title,
    artist: entry.artist,
  };
  if (entry.album !== undefined) track.album = entry.album;
  if (entry.durationSec !== undefined) track.durationSec = entry.durationSec;
  if (entry.artUrl !== undefined) track.artUrl = entry.artUrl;
  if (entry.source) {
    track.source = {
      site: entry.source.site,
      url: entry.source.url,
    };
    if (entry.source.id !== undefined) track.source.id = entry.source.id;
  }
  if (entry.catalogFile !== undefined) track.catalogFile = entry.catalogFile;
  return track;
}

/**
 * Identity of an entry's wire data, so the mapped `Track` (and
 * `TrackArtService`'s per-object art cache) survives ticks and unrelated
 * session updates. `entryId` is included because the same song may recur.
 */
export function sessionTrackSignature(entry: SessionTrack): string {
  return JSON.stringify([
    entry.entryId,
    entry.id,
    entry.providerId,
    entry.title,
    entry.artist,
    entry.album,
    entry.durationSec,
    entry.artUrl,
    entry.source?.site,
    entry.source?.url,
    entry.source?.id,
    entry.catalogFile,
    entry.uploadId,
    entry.local === true,
  ]);
}
