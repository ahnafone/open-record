/**
 * One track from a Spotify export, reduced to the fields matching needs.
 * Never holds raw Spotify payloads.
 */
export interface ImportedTrack {
  title: string;
  /** Credited artists in order; at least one entry (may be empty strings for odd rows). */
  artists: string[];
  /** Display artist: `artists` joined with ", ". */
  artist: string;
  album?: string;
  durationMs?: number;
  isrc?: string;
  /** Spotify track id (base62), when the source had a track URI. */
  spotifyId?: string;
  /** ISO timestamp the track was added to the playlist / library, when known. */
  addedAt?: string;
}

export interface ImportedPlaylist {
  name: string;
  tracks: ImportedTrack[];
}

/** Everything read from one or more export files. */
export interface ParsedImport {
  playlists: ImportedPlaylist[];
  /** Liked Songs / saved tracks. */
  liked: ImportedTrack[];
}
