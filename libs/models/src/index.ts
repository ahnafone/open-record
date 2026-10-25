// Public API for @open-record/models. Shared domain types, no dependencies.

/**
 * A playable record. `id` is globally unique across providers (providers
 * namespace their ids, e.g. `catalog:sandman`) so it can be stored in
 * playlists on its own; `providerId` routes resolution to the owning provider.
 */
export interface Track {
  id: string;
  providerId: string;
  title: string;
  artist: string;
  year?: number;
  genre?: string;
  durationSec?: number;
  artUrl?: string;
  tags?: string[];
  license?: string;
  credit?: string;
  album?: string;
  /** Provider-relative key of the stored audio file (e.g. `imported/<id>.audio.mp3`). */
  sourceFile?: string;
  /** Size of the stored audio file in bytes. */
  sizeBytes?: number;
  /**
   * Provider-relative key of stored cover art. Unlike `artUrl` it is stable
   * across launches; the owning provider turns it into a loadable URL.
   */
  coverPath?: string;
  /** Fields the user edited by hand. */
  userEdited?: EditableTrackField[];
  /** Where the audio came from when it was downloaded through the download server. */
  source?: TrackSource;
  /** International Standard Recording Code, when known (e.g. from a Spotify import). */
  isrc?: string;
  /** Ids of the same recording on other services (kept from imports for re-matching). */
  external?: { spotifyId?: string };
}

/** Origin of a downloaded track: the site and page URL it was fetched from. */
export interface TrackSource {
  /** Site key, e.g. `youtube`, `soundcloud`, or the server's extractor name for pasted links. */
  site: string;
  /** Page URL the audio was downloaded from. */
  url: string;
  /** The site's own id for the item, when known. */
  id?: string;
}

// ---------------------------------------------------------------------------
// Download server wire types (JSON over HTTP, bearer auth). Shared by the
// server (apps/server) and the remote provider (libs/providers/remote).
// ---------------------------------------------------------------------------

/** Sites the download server can search. Any supported URL can still be pasted. */
export const DOWNLOAD_SITES = ['youtube', 'ytmusic', 'soundcloud', 'bandcamp', 'audiomack', 'mixcloud'] as const;
export type DownloadSite = (typeof DOWNLOAD_SITES)[number];

/**
 * Audio quality levels for `POST /stream` (`quality`, optional, default
 * `highest`). Each level other than `highest` caps the average bitrate; the
 * server falls back to the closest available format.
 */
export const AUDIO_QUALITIES = ['highest', 'high', 'medium', 'low'] as const;
export type AudioQuality = (typeof AUDIO_QUALITIES)[number];
export const DEFAULT_AUDIO_QUALITY: AudioQuality = 'highest';

export function isAudioQuality(value: unknown): value is AudioQuality {
  return typeof value === 'string' && (AUDIO_QUALITIES as readonly string[]).includes(value);
}

/** One `GET /search` hit, or the `POST /resolve` result. */
export interface RemoteSearchResult {
  id: string;
  title: string;
  artist: string;
  durationSec?: number;
  thumbnailUrl?: string;
  url: string;
  site: string;
}

/** Track fields the user may edit on imported tracks. */
export type EditableTrackField = 'title' | 'artist' | 'album' | 'year' | 'genre';

/** Where the audio for a track can be loaded from. */
export interface PlayableSource {
  url: string;
  kind: 'remote' | 'file' | 'bundled';
  mimeType?: string;
}

export interface Playlist {
  id: string;
  name: string;
  visibility: 'private' | 'public';
  trackIds: string[];
  /** Epoch milliseconds. */
  createdAt: number;
  /** Epoch milliseconds. */
  updatedAt: number;
  /** Keep every track of this playlist saved on the device. Absent = off. */
  autoDownload?: boolean;
}

export type Role = 'owner' | 'editor' | 'viewer';

export interface Member {
  id: string;
  name: string;
  role: Role;
}

export * from './lib/pairing';
