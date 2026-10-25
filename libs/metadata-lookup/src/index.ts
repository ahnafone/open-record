// Public API for @open-record/metadata-lookup. Pure: the caller injects fetch.
export { lookupMetadata, type MetadataLookupResult } from './lib/lookup';
export { normalizeArtist, normalizeTitle } from './lib/normalize';
export { MATCH_THRESHOLD, pickBest } from './lib/score';
export type { MetadataFetch, MetadataFetchInit } from './lib/providers';
export type { MetadataMatch, MetadataQuery, MetadataSource } from './lib/types';
