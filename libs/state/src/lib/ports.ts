import type {
  DownloadJobStatus,
  DownloadSite,
  Track,
} from '@open-record/models';

/**
 * Ports the app provides through Angular DI. State may not import provider
 * libs, so this mirrors (structurally) the parts of `LocalProvider`
 * (@open-record/providers/local) the stores use. It is optional: without it
 * import and stored cover art are simply unavailable.
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
  /** Delete a track's stored files; resolves to bytes freed. */
  abstract remove(trackId: string): Promise<number>;
  /** Delete stored files not belonging to `keepTrackIds`; resolves to bytes freed. */
  abstract cleanup(keepTrackIds: Iterable<string>): Promise<number>;
  abstract usage(): Promise<{ audioBytes: number; artBytes: number }>;
}

/** Progress of one server download (mirrors `DownloadProgress` in @open-record/providers/remote). */
export interface RemoteDownloadProgress {
  phase: 'starting' | DownloadJobStatus | 'saving';
  /** 0-100. */
  progress: number;
  jobId?: string;
}

/**
 * The self-hosted download server (the `remote` music source). Mirrors
 * (structurally) `RemoteProvider` from @open-record/providers/remote; the app
 * provides it as `{ provide: RemoteDownloadPort, useValue: remote }`.
 * Errors are the provider's typed errors (`AuthError`, `NetworkError`, ...);
 * match on `error.name` here since state cannot import them.
 */
export abstract class RemoteDownloadPort {
  /** Set or clear the server URL + token (throws for a non-http(s) URL). */
  abstract configure(config: { baseUrl: string; token: string } | null): void;
  abstract readonly configured: boolean;
  /** Settings "Test connection": reachable and token accepted (rejects otherwise). */
  abstract testConnection(signal?: AbortSignal): Promise<void>;
  /** Search one site; results are not playable until downloaded. */
  abstract searchSite(
    query: string,
    site: DownloadSite,
    signal?: AbortSignal,
  ): Promise<Track[]>;
  /** A pasted link as a Track. */
  abstract resolveUrl(url: string, signal?: AbortSignal): Promise<Track>;
  /**
   * Download through the server and import into app storage. Resolves to a
   * new `local:` track with `source` set; the caller persists it.
   */
  abstract downloadToLibrary(
    trackOrUrl: Track | string,
    options?: {
      signal?: AbortSignal;
      onProgress?(progress: RemoteDownloadProgress): void;
    },
  ): Promise<Track>;
}
