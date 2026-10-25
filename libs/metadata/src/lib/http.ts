/**
 * Injectable HTTP port so the metadata library stays framework-free.
 * Adapters may throw; the service catches everything.
 */
export interface MetadataHttpResponse<T> {
  /** HTTP status after redirects were followed. */
  status: number;
  /** Parsed body, or null when the body was empty or unreadable. */
  data: T | null;
  /** Response Content-Type, when the adapter knows it. */
  contentType?: string;
}

export interface MetadataHttp {
  /** False where online lookups must be skipped (e.g. plain web builds). */
  readonly available: boolean;
  /** GET a JSON document. */
  getJson(url: string): Promise<MetadataHttpResponse<unknown>>;
  /** GET raw bytes (redirects must be followed). */
  getBytes(url: string): Promise<MetadataHttpResponse<ArrayBuffer>>;
}

/** Identifying User-Agent required by MusicBrainz. */
export const METADATA_USER_AGENT = 'OpenRecord/0.1 (https://github.com/open-record)';
