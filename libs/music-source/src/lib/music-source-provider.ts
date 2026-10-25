import type { PlayableSource, Track } from '@open-record/models';

/**
 * Destination for a provider download (e.g. an app-storage file). Providers
 * stream bytes into it; the caller decides where they end up.
 */
export interface DownloadSink {
  /** Called once before any data, with whatever is known about the payload. */
  start?(info: { mimeType?: string; sizeBytes?: number }): void | Promise<void>;
  write(chunk: Uint8Array): Promise<void>;
  /** Finalise the download after the last chunk. */
  close(): Promise<void>;
  /** Discard partial data after a failure or cancellation. */
  abort(reason?: unknown): Promise<void>;
}

export interface MusicSourceProvider {
  id: string;
  capabilities: { search: boolean; download: boolean };
  search(query: string): Promise<Track[]>;
  /** Every track the provider can offer without a query (e.g. a bundled catalogue). */
  list?(): Promise<Track[]>;
  /** Resolve a track id (Track.id) to something the player can load. */
  resolve(trackId: string): Promise<PlayableSource>;
  download?(trackId: string, sink: DownloadSink): Promise<void>;
}
