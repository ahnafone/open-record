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
  /**
   * The title and uploader as the source showed them, kept when catalogue
   * metadata replaced `title`/`artist` (e.g. YouTube playlist imports).
   */
  originalTitle?: string;
  originalArtist?: string;
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

/** Most entries `POST /playlist` returns; longer playlists are cut (`truncated`). */
export const MAX_PLAYLIST_ENTRIES = 500;

/** One video of a public YouTube / YT Music playlist (`POST /playlist`). */
export interface RemotePlaylistEntry {
  /** The 11-character video id. */
  id: string;
  /** Canonical watch URL (youtube.com or music.youtube.com). */
  url: string;
  site: string;
  /** Best track title (YT Music track name, else the cleaned video title). */
  title: string;
  /** Best artist guess; empty when unknown. */
  artist: string;
  /** The video title exactly as YouTube shows it. */
  originalTitle: string;
  /** Channel / uploader name. */
  uploader?: string;
  album?: string;
  durationSec?: number;
  thumbnailUrl?: string;
}

/** `POST /playlist {url}`: a public playlist's flat entry list, or one song (metadata only). */
export interface RemotePlaylist {
  /** The playlist id (`list=`), or the video id for a single song. */
  id: string;
  title: string;
  /** Canonical playlist URL. */
  url: string;
  site: string;
  uploader?: string;
  entries: RemotePlaylistEntry[];
  /** Private, deleted or otherwise unplayable entries that were left out. */
  unavailable: number;
  /** True when the playlist had more than {@link MAX_PLAYLIST_ENTRIES} entries. */
  truncated: boolean;
  /** The link was a single song: `entries` holds just that song and no playlist is made. */
  single?: boolean;
}

/** Most songs per `POST /meta/enrich` call. */
export const MAX_ENRICH_BATCH = 10;

/** One song to look up in public catalogues (`POST /meta/enrich`). */
export interface EnrichQuery {
  title: string;
  artist: string;
  durationSec?: number;
  album?: string;
}

/** Catalogues `POST /meta/enrich` consults, highest priority first. */
export const ENRICH_SOURCES = ['ytmusic', 'itunes', 'deezer', 'musicbrainz'] as const;
export type EnrichSource = (typeof ENRICH_SOURCES)[number];

/**
 * A confident catalogue match for one {@link EnrichQuery}: fields from the
 * highest-priority confident source, gaps filled from the others.
 */
export interface EnrichMatch {
  title: string;
  artist: string;
  album?: string;
  year?: number;
  genre?: string;
  artUrl?: string;
  durationSec?: number;
  /** 0..1 score of the primary source's candidate. */
  confidence: number;
  /** Sources that agreed, primary first. */
  sources: EnrichSource[];
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
  /** When each track was added (track id -> epoch ms). Absent entry = unknown. */
  addedAt?: Record<string, number>;
}

export type Role = 'owner' | 'editor' | 'viewer';

export interface Member {
  id: string;
  name: string;
  role: Role;
}

export * from './lib/pairing';
export * from './lib/download-location';
