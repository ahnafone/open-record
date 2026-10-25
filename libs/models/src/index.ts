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
  /** MusicBrainz identifiers, when known (from file tags or a lookup). */
  mbids?: TrackMbids;
  /** Provider-relative key of the stored audio file (e.g. `imported/<id>.audio.mp3`). */
  sourceFile?: string;
  /** Size of the stored audio file in bytes. */
  sizeBytes?: number;
  /**
   * Provider-relative key of stored cover art. Unlike `artUrl` it is stable
   * across launches; the owning provider turns it into a loadable URL.
   */
  coverPath?: string;
  /** Online metadata enrichment state (imported tracks only). */
  enrichment?: EnrichmentStatus;
  /** Fields the user edited by hand; enrichment never touches these. */
  userEdited?: EditableTrackField[];
}

/** `none`: not queued; `pending`: waiting for a lookup; `done`/`failed`: looked up. */
export type EnrichmentStatus = 'none' | 'pending' | 'done' | 'failed';

/** Track fields the user may edit on imported tracks. */
export type EditableTrackField = 'title' | 'artist' | 'album' | 'year' | 'genre';

export interface TrackMbids {
  recording?: string;
  release?: string;
  artist?: string;
}

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
}

export type Role = 'owner' | 'editor' | 'viewer';

export interface Member {
  id: string;
  name: string;
  role: Role;
}
