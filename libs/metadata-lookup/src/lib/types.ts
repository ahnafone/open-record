export type MetadataSource = 'itunes' | 'deezer';

/** A catalogue entry chosen for a track. */
export interface MetadataMatch {
  title: string;
  artist: string;
  album?: string;
  year?: number;
  genre?: string;
  /** High-resolution cover URL on the iTunes or Deezer CDN. */
  artworkUrl?: string;
  durationSec?: number;
  /** Deezer artist id (Deezer matches only). */
  artistId?: string;
  /** Deezer artist portrait (https, placeholder silhouettes dropped). */
  artistImageUrl?: string;
  source: MetadataSource;
}

/** A Deezer artist portrait found by an exact name match. */
export interface ArtistImage {
  id?: string;
  imageUrl: string;
}

/** What we know about the track being looked up (usually from yt-dlp). */
export interface MetadataQuery {
  title: string;
  artist?: string;
  durationSec?: number;
}
