// Public API for @open-record/metadata. Online metadata (MusicBrainz + Cover Art Archive).
export { METADATA_USER_AGENT } from './lib/http';
export type { MetadataHttp, MetadataHttpResponse } from './lib/http';
export { CapacitorMetadataHttp } from './lib/capacitor-http';
export { FetchMetadataHttp } from './lib/fetch-http';
export type { FetchMetadataHttpOptions } from './lib/fetch-http';
export { RateLimiter } from './lib/rate-limiter';
export type { RateLimiterClock } from './lib/rate-limiter';
export {
  ENRICH_SCORE_THRESHOLD,
  bestCandidate,
  durationScore,
  parseRecordingSearch,
  scoreCandidate,
  similarity,
} from './lib/musicbrainz';
export type { EnrichQuery, MetadataRecording } from './lib/musicbrainz';
export { MetadataService } from './lib/metadata-service';
export type { CoverArt, EnrichResult, MetadataServiceOptions } from './lib/metadata-service';
export {
  COVER_ART_ARCHIVE_ATTRIBUTION,
  METADATA_ATTRIBUTIONS,
  MUSICBRAINZ_ATTRIBUTION,
} from './lib/attribution';
export type { MetadataAttribution } from './lib/attribution';
