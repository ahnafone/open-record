import { MetadataHttp } from './http';
import {
  ENRICH_SCORE_THRESHOLD,
  EnrichQuery,
  MetadataRecording,
  bestCandidate,
  buildEnrichQuery,
  parseGenres,
  parseRecordingSearch,
} from './musicbrainz';
import { RateLimiter } from './rate-limiter';

export interface CoverArt {
  bytes: ArrayBuffer;
  mimeType: string;
  /** URL that was requested (before redirects). */
  sourceUrl: string;
}

export interface EnrichResult extends MetadataRecording {
  /** 0..1 confidence from `scoreCandidate`. */
  matchScore: number;
  coverArt: CoverArt | null;
}

export interface MetadataServiceOptions {
  /** Shared queue; defaults to one 1 req/s limiter per service. */
  limiter?: RateLimiter;
  /** Defaults to `ENRICH_SCORE_THRESHOLD`. */
  threshold?: number;
  /** Max results for `searchRecordings` (1-100, default 25). */
  searchLimit?: number;
  /** Fetch cover art bytes in `enrich` (default true). */
  coverArt?: boolean;
}

const MB_BASE = 'https://musicbrainz.org/ws/2';
const CAA_BASE = 'https://coverartarchive.org';

/**
 * MusicBrainz + Cover Art Archive lookups. Every request (MB and CAA) goes
 * through one 1 req/s queue. Never throws: failures yield [] / null, and when
 * the HTTP port is unavailable (web) nothing is requested at all.
 */
export class MetadataService {
  private readonly limiter: RateLimiter;
  private readonly threshold: number;
  private readonly searchLimit: number;
  private readonly fetchCoverArt: boolean;

  constructor(
    private readonly http: MetadataHttp,
    options: MetadataServiceOptions = {},
  ) {
    this.limiter = options.limiter ?? new RateLimiter(1000);
    this.threshold = options.threshold ?? ENRICH_SCORE_THRESHOLD;
    this.searchLimit = Math.min(Math.max(options.searchLimit ?? 25, 1), 100);
    this.fetchCoverArt = options.coverArt ?? true;
  }

  /** False on web/non-native: callers should skip online lookups. */
  get available(): boolean {
    return this.http.available;
  }

  /** Free-text recording search. Info-only results; [] on any failure. */
  async searchRecordings(query: string, limit = this.searchLimit): Promise<MetadataRecording[]> {
    const q = query.trim();
    if (!this.available || !q) return [];
    return parseRecordingSearch(await this.mbSearch(q, limit));
  }

  /** Best match above the threshold with cover art, or null. */
  async enrich(query: EnrichQuery): Promise<EnrichResult | null> {
    if (!this.available || !query.title?.trim() || !query.artist?.trim()) return null;
    try {
      const body = await this.mbSearch(buildEnrichQuery(query), 10);
      const best = bestCandidate(query, parseRecordingSearch(body, query.album), this.threshold);
      if (!best) return null;
      const match = best.candidate;
      const genres = match.genres.length ? match.genres : await this.releaseGroupGenres(match.releaseGroupMbid);
      const coverArt = this.fetchCoverArt ? await this.coverArt(match) : null;
      return { ...match, genres, matchScore: best.score, coverArt };
    } catch {
      return null;
    }
  }

  /** Front cover (500px) for a release, falling back to its release group. */
  async coverArt(ids: { releaseMbid?: string; releaseGroupMbid?: string }): Promise<CoverArt | null> {
    if (!this.available) return null;
    const urls = [
      ids.releaseMbid && `${CAA_BASE}/release/${encodeURIComponent(ids.releaseMbid)}/front-500`,
      ids.releaseGroupMbid && `${CAA_BASE}/release-group/${encodeURIComponent(ids.releaseGroupMbid)}/front-500`,
    ].filter((u): u is string => !!u);
    for (const url of urls) {
      const res = await this.request(() => this.http.getBytes(url));
      if (res && res.status >= 200 && res.status < 300 && res.data && res.data.byteLength > 0) {
        return { bytes: res.data, mimeType: res.contentType?.split(';')[0].trim() || 'image/jpeg', sourceUrl: url };
      }
    }
    return null;
  }

  private async releaseGroupGenres(id?: string): Promise<string[]> {
    if (!id) return [];
    const res = await this.request(() =>
      this.http.getJson(`${MB_BASE}/release-group/${encodeURIComponent(id)}?inc=genres+tags&fmt=json`),
    );
    return res && res.status === 200 ? parseGenres(res.data) : [];
  }

  private async mbSearch(lucene: string, limit: number): Promise<unknown> {
    const url = `${MB_BASE}/recording?query=${encodeURIComponent(lucene)}&limit=${limit}&fmt=json`;
    const res = await this.request(() => this.http.getJson(url));
    return res && res.status === 200 ? res.data : null;
  }

  /** Queue a request; swallow any adapter/network error as null. */
  private async request<T>(fn: () => Promise<T>): Promise<T | null> {
    try {
      return await this.limiter.schedule(fn);
    } catch {
      return null;
    }
  }
}
