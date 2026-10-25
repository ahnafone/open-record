import { InjectionToken } from '@angular/core';
import type { DownloadSite, Track } from '@open-record/models';
import type { MetadataFetch } from '@open-record/metadata-lookup';

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
  /**
   * Delete a track's stored files; resolves to bytes freed. Pass the track
   * (or just its id for `local:` tracks) so files stored under other keys,
   * such as streamed-and-saved `remote:` tracks, are found via `sourceFile`.
   */
  abstract remove(
    track: string | Pick<Track, 'id' | 'sourceFile'>,
  ): Promise<number>;
  /** Delete stored files not belonging to `keepTrackIds`; resolves to bytes freed. */
  abstract cleanup(keepTrackIds: Iterable<string>): Promise<number>;
  abstract usage(): Promise<{ audioBytes: number; artBytes: number }>;
}

/**
 * The self-hosted server (the `remote` music source): search, pasted links and
 * the settings connection check. Mirrors (structurally) `RemoteProvider` from
 * @open-record/providers/remote; the app provides it as
 * `{ provide: RemoteServerPort, useValue: remote }`. Errors are the provider's
 * typed errors (`AuthError`, `NetworkError`, ...); match on `error.name` here
 * since state cannot import them.
 */
export abstract class RemoteServerPort {
  /** Set or clear the server URL + token (throws for a non-http(s) URL). */
  abstract configure(config: { baseUrl: string; token: string } | null): void;
  abstract readonly configured: boolean;
  /** Settings "Test connection": reachable and token accepted (rejects otherwise). */
  abstract testConnection(signal?: AbortSignal): Promise<void>;
  /** Search one site; results stream on play or save. */
  abstract searchSite(
    query: string,
    site: DownloadSite,
    signal?: AbortSignal,
  ): Promise<Track[]>;
  /** A pasted link as a Track. */
  abstract resolveUrl(url: string, signal?: AbortSignal): Promise<Track>;
}

/**
 * Stream and save-to-device for the self-hosted server (the `remote` music
 * source). Implemented by the app over `libs/providers/remote`; state only
 * depends on this shape. `sourceFile` must be a store-relative path under the
 * local media store (e.g. `imported/<key>.audio.m4a`), as `LocalMediaPort.remove`
 * expects.
 */
export abstract class StreamResolverPort {
  /** Resolve a page URL to a playable direct link (short-lived; honour `expiresAt`). */
  abstract resolve(
    pageUrl: string,
    signal?: AbortSignal,
  ): Promise<{
    url: string;
    mimeType?: string;
    expiresAt?: number;
    headers?: Record<string, string>;
    meta?: {
      title: string;
      artist: string;
      album?: string;
      durationSec?: number;
      artworkUrl?: string;
    };
  }>;
  /** Download the page's audio into app storage under `opts.id`. */
  abstract saveToDevice(
    pageUrl: string,
    opts: {
      id: string;
      onProgress?: (fraction: number) => void;
      signal?: AbortSignal;
    },
  ): Promise<{ sourceFile: string; sizeBytes: number; mimeType?: string }>;
}

/**
 * Optional injected fetch for `@open-record/metadata-lookup` (iTunes/Deezer).
 * Provide it in the app (CapacitorHttp on native). Without it, no
 * background metadata lookup runs after a save.
 */
export const METADATA_FETCH = new InjectionToken<MetadataFetch>(
  'METADATA_FETCH',
);

/**
 * Camera QR scanning for pairing with the download server. Provided by the
 * app on native platforms only; without it the Settings scan button is hidden.
 */
export abstract class PairingScannerPort {
  /** True when this device can scan QR codes (native platform with a camera). */
  abstract available(): Promise<boolean>;
  /**
   * Open the scanner. Resolves to the first scanned text, or null when the user
   * cancels. Rejects with an Error whose message is shown to the user when the
   * scanner cannot run (for example, camera permission denied).
   */
  abstract scan(): Promise<string | null>;
}
