export type MetadataSource = 'itunes' | 'deezer';

/** A catalogue entry chosen for a track. Returned by `GET /metadata`. */
export interface MetadataMatch {
  title: string;
  artist: string;
  album?: string;
  year?: number;
  genre?: string;
  /** High-resolution cover URL on the iTunes or Deezer CDN. */
  artworkUrl?: string;
  durationSec?: number;
  source: MetadataSource;
}

/** What we know about the track being looked up (usually from yt-dlp). */
export interface MetadataQuery {
  title: string;
  artist?: string;
  durationSec?: number;
}
