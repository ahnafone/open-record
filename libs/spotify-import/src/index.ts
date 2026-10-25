// Public API for @open-record/spotify-import. Pure: parses Spotify exports and scores matches; no I/O.
export { parseCsv, toCsv } from './lib/csv';
export {
  AUTO_ACCEPT_SCORE,
  DURATION_OK_SEC,
  DURATION_REJECT_SEC,
  DURATION_STRONG_SEC,
  REVIEW_SCORE,
  VERSION_PENALTY,
  matchQuery,
  matchTrack,
  scoreCandidate,
  type MatchCandidate,
  type MatchResult,
  type MatchVerdict,
  type ScoredCandidate,
} from './lib/match';
export {
  ImportFormatError,
  countTracks,
  isLikedSongsFile,
  mapSpotifyApiTrack,
  mapSpotifyApiTracks,
  mergeImports,
  parseDataDownloadJson,
  parseExportifyCsv,
  parseImportFile,
} from './lib/parsers';
export { dedupeTracks, spotifyIdFromUri, splitArtists, trackKey } from './lib/tracks';
export type { ImportedPlaylist, ImportedTrack, ParsedImport } from './lib/types';
