import type { Track } from '@open-record/models';

/**
 * Ports the app provides through Angular DI. State may not import provider
 * or metadata libs, so these mirror (structurally) the parts of
 * `LocalProvider` (@open-record/providers/local) and `MetadataService`
 * (@open-record/metadata) the stores use. Both are optional: without them
 * import, cover art and online metadata are simply unavailable.
 */

export interface LocalImportFailure {
  fileName: string;
  error: unknown;
}

export interface LocalImportResult {
  /** New tracks (not yet persisted; the library store saves them). */
  tracks: Track[];
  failures: LocalImportFailure[];
}

/** Imported-file storage (the `local` music source). */
export abstract class LocalMediaPort {
  /** Open the system picker and copy the chosen files into app storage. */
  abstract pickAndImport(): Promise<LocalImportResult>;
  /** Loadable URL for `coverPath`. Not stable across launches: never persist. */
  abstract artUrl(track: Pick<Track, 'coverPath'>): Promise<string | undefined>;
  /** Store fetched cover art for a local track; resolves to its `coverPath`. */
  abstract storeCover(trackId: string, data: Uint8Array, mimeType: string): Promise<string | undefined>;
  /** Delete a track's stored files; resolves to bytes freed. */
  abstract remove(trackId: string): Promise<number>;
  /** Delete stored files not belonging to `keepTrackIds`; resolves to bytes freed. */
  abstract cleanup(keepTrackIds: Iterable<string>): Promise<number>;
  abstract usage(): Promise<{ audioBytes: number; artBytes: number }>;
}

/** Info-only online recording (MusicBrainz). Not playable. */
export interface OnlineRecording {
  recordingMbid: string;
  title: string;
  artist: string;
  artistMbids: string[];
  album?: string;
  releaseMbid?: string;
  releaseGroupMbid?: string;
  year?: number;
  durationMs?: number;
  genres: string[];
}

export interface MetadataQuery {
  title: string;
  artist: string;
  album?: string;
  durationMs?: number;
}

export interface MetadataMatch extends OnlineRecording {
  matchScore: number;
  coverArt: { bytes: ArrayBuffer; mimeType: string } | null;
}

/**
 * Online metadata lookups. Provide ONE app-wide instance (it owns the
 * 1 req/s queue). Implementations never throw.
 */
export abstract class MetadataPort {
  /** False when lookups cannot run (e.g. web). */
  abstract readonly available: boolean;
  abstract searchRecordings(query: string): Promise<OnlineRecording[]>;
  /** Best match above the confidence threshold, or null. */
  abstract enrich(query: MetadataQuery): Promise<MetadataMatch | null>;
}
