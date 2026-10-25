import { METADATA_USER_AGENT, MetadataHttp, MetadataHttpResponse } from './http';

export interface FetchMetadataHttpOptions {
  /** Defaults to true. Pass false to make the service a no-op. */
  available?: boolean;
  /** Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

/**
 * Plain `fetch` adapter (Node, tests, tooling). Browsers silently drop the
 * User-Agent header and MusicBrainz/CAA may be blocked by CORS there, so the
 * app should prefer `CapacitorMetadataHttp`.
 */
export class FetchMetadataHttp implements MetadataHttp {
  readonly available: boolean;
  private readonly fetchFn: typeof fetch;

  constructor(options: FetchMetadataHttpOptions = {}) {
    this.available = options.available ?? true;
    this.fetchFn = options.fetch ?? ((input, init) => fetch(input, init));
  }

  async getJson(url: string): Promise<MetadataHttpResponse<unknown>> {
    const res = await this.fetchFn(url, {
      headers: { 'User-Agent': METADATA_USER_AGENT, Accept: 'application/json' },
      redirect: 'follow',
    });
    let data: unknown = null;
    if (res.ok) {
      try {
        data = await res.json();
      } catch {
        data = null;
      }
    }
    return { status: res.status, data, contentType: res.headers.get('content-type') ?? undefined };
  }

  async getBytes(url: string): Promise<MetadataHttpResponse<ArrayBuffer>> {
    const res = await this.fetchFn(url, {
      headers: { 'User-Agent': METADATA_USER_AGENT },
      redirect: 'follow',
    });
    return {
      status: res.status,
      data: res.ok ? await res.arrayBuffer() : null,
      contentType: res.headers.get('content-type') ?? undefined,
    };
  }
}
