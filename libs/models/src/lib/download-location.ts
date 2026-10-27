/**
 * Where new downloads are written on a native device.
 * - `data`: app-private storage (Capacitor `Directory.Data`), the default.
 * - `external`: Android app-specific external storage (`Directory.External`),
 *   no permission needed; removed with the app like `data`.
 */
export const DOWNLOAD_LOCATIONS = ['data', 'external'] as const;
export type DownloadLocation = (typeof DOWNLOAD_LOCATIONS)[number];
export const DEFAULT_DOWNLOAD_LOCATION: DownloadLocation = 'data';

export function isDownloadLocation(value: unknown): value is DownloadLocation {
  return typeof value === 'string' && (DOWNLOAD_LOCATIONS as readonly string[]).includes(value);
}

const EXTERNAL_PREFIX = 'external:';

/**
 * Stored file path for a download. `data` paths stay unprefixed so files
 * saved before this setting existed keep resolving to `Directory.Data`.
 */
export function withDownloadLocation(path: string, location: DownloadLocation): string {
  return location === 'external' ? `${EXTERNAL_PREFIX}${path}` : path;
}

/** Split a stored path into its location and the directory-relative path. */
export function splitStoredPath(stored: string): { location: DownloadLocation; path: string } {
  return stored.startsWith(EXTERNAL_PREFIX)
    ? { location: 'external', path: stored.slice(EXTERNAL_PREFIX.length) }
    : { location: 'data', path: stored };
}
