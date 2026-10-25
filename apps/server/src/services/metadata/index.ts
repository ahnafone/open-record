export { applyMetadata, enrichFile, isAllowedArtworkUrl, type ApplyOptions, type EnrichOptions } from './apply';
export { clearMetadataCache, lookupMetadata, type LookupOptions } from './lookup';
export { normalizeArtist, normalizeTitle } from './normalize';
export { MATCH_THRESHOLD, pickBest } from './score';
export type { MetadataMatch, MetadataQuery, MetadataSource } from './types';
