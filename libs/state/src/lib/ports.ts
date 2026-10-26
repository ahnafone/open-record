import { InjectionToken } from '@angular/core';
import type { AudioQuality, DownloadSite, Track } from '@open-record/models';
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
  /**
   * Catalogue aliases (other-script/other-language titles and artist names)
   * for import matching. Optional; the remote provider never rejects (empty
   * lists on any failure).
   */
  aliases?(
    query: { artist: string; title: string; isrc?: string },
    signal?: AbortSignal,
  ): Promise<{ titles: string[]; artists: string[] }>;
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
    quality?: AudioQuality,
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
      /** Download quality; omitted = highest. */
      quality?: AudioQuality;
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

/** How the device is connected right now. */
export interface NetworkState {
  connected: boolean;
  /**
   * `wifi` and `ethernet` count as unmetered; `cellular` as mobile data;
   * `unknown` when the platform cannot tell (treated as unmetered).
   */
  connectionType: 'wifi' | 'ethernet' | 'cellular' | 'none' | 'unknown';
}

/**
 * Connection status for background work (auto-download). The app provides
 * it (Capacitor Network on native, `navigator.connection` on web). Without
 * it the connection is assumed to be unmetered and online.
 */
export abstract class NetworkStatusPort {
  abstract current(): Promise<NetworkState>;
  /** Calls `listener` on every change; returns an unsubscribe function. */
  abstract onChange(listener: (state: NetworkState) => void): () => void;
}

/** Supabase project the app signs in against (the anon key is public by design). */
export interface AuthProjectConfig {
  url: string;
  anonKey: string;
}

/** The signed-in account. */
export interface AuthUser {
  id: string;
  email?: string;
}

/**
 * Optional accounts (Supabase Auth). The app provides it over
 * `@supabase/supabase-js`; without it, or with no project available, the app
 * runs fully anonymous. The project is never entered by the user: it comes
 * from the build or from the download server (`GET /app-config`). Methods
 * reject with an Error whose message is shown to the user. Session tokens are
 * kept by the adapter (never in settings).
 */
export abstract class AuthPort {
  /** The project in use (build-time, else the server's), or null when accounts are not set up. */
  abstract activeProject(): Promise<AuthProjectConfig | null>;
  /** Start the client for the active project and restore its session. */
  abstract restore(): Promise<AuthUser | null>;
  /** Calls `listener` on sign-in, sign-out and token refresh; returns an unsubscribe function. */
  abstract onChange(listener: (user: AuthUser | null) => void): () => void;
  /** Resolves `needsConfirmation` when the project requires email confirmation first. */
  abstract signUp(email: string, password: string): Promise<{ needsConfirmation: boolean }>;
  abstract signIn(email: string, password: string): Promise<AuthUser>;
  abstract signOut(): Promise<void>;
  /** Email a password reset link. */
  abstract resetPassword(email: string): Promise<void>;
  /** Calls `listener` when the user arrives from a reset link (a recovery session); returns an unsubscribe function. */
  abstract onRecovery(listener: () => void): () => void;
  /** Set a new password for the signed-in (recovery) session. */
  abstract updatePassword(password: string): Promise<void>;
  /** Current access token (refreshed when needed), or null when signed out. */
  abstract accessToken(): Promise<string | null>;
}

/**
 * Track metadata that syncs between devices. Deliberately small: never audio,
 * file paths, raw provider payloads or user-edited cover files.
 */
export interface SyncTrack {
  id: string;
  providerId: string;
  title: string;
  artist: string;
  album?: string;
  year?: number;
  genre?: string;
  durationSec?: number;
  artUrl?: string;
  isrc?: string;
  spotifyId?: string;
  sourceSite?: string;
  sourceUrl?: string;
  sourceId?: string;
}

/**
 * One synced library entry: a track's metadata and whether it is saved.
 * Clocks are epoch milliseconds; `deletedAt` marks a tombstone (no `track`).
 */
export interface SyncLibraryItem {
  trackId: string;
  track?: SyncTrack;
  saved: boolean;
  savedAt?: number;
  updatedAt: number;
  deletedAt?: number;
}

/** One synced playlist with its ordered track ids; `deletedAt` marks a tombstone. */
export interface SyncPlaylist {
  id: string;
  name: string;
  visibility: 'private' | 'public';
  autoDownload: boolean;
  trackIds: string[];
  /**
   * Track id -> epoch ms it was added. Optional: older clients and the cloud
   * copy may not carry it; it is not part of the content hash.
   */
  addedAt?: Record<string, number>;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
}

export interface SyncSnapshot {
  library: SyncLibraryItem[];
  playlists: SyncPlaylist[];
}

/**
 * Cloud copy of the signed-in user's library and playlists (Supabase). The
 * app provides it next to `AuthPort`; without it sync is off. The remote side
 * applies last-write-wins on `updatedAt`, so pushing a stale item is harmless.
 */
export abstract class SyncPort {
  /** The account the cloud copy belongs to, or null when signed out / unconfigured. */
  abstract userId(): Promise<string | null>;
  /** Every row of the account, tombstones included. */
  abstract pull(): Promise<SyncSnapshot>;
  /** Upsert these items and playlists (tombstones included). */
  abstract push(changes: SyncSnapshot): Promise<void>;
}
