import {
  artistSimilarity,
  fold,
  normalizeArtist,
  normalizeTitle,
  primaryArtist,
  splitArtistTitle,
  titleSimilarity,
} from '@open-record/metadata-lookup';
import type { ImportedTrack } from './types';

/** Score at or above which a candidate with a duration match is accepted without review. */
export const AUTO_ACCEPT_SCORE = 0.85;
/** Score at or above which a candidate is offered for manual review. */
export const REVIEW_SCORE = 0.6;
/** Duration difference (seconds) counted as a strong match. */
export const DURATION_STRONG_SEC = 2;
/** Duration difference (seconds) still counted as a match (required for auto-accept). */
export const DURATION_OK_SEC = 5;
/** Duration difference (seconds) beyond which a candidate is rejected outright. */
export const DURATION_REJECT_SEC = 10;
/** Subtracted when a candidate is a live / cover / remix etc. that the Spotify track is not. */
export const VERSION_PENALTY = 0.25;

/** The fields of a search result (e.g. a remote Track or RemoteSearchResult) scoring needs. */
export interface MatchCandidate {
  title: string;
  artist: string;
  durationSec?: number;
  album?: string;
}

export type MatchVerdict = 'matched' | 'review' | 'unmatched';

export interface ScoredCandidate<C extends MatchCandidate = MatchCandidate> {
  candidate: C;
  /** 0..1. */
  score: number;
  /** Duration known on both sides and within DURATION_OK_SEC. */
  durationMatch: boolean;
}

export interface MatchResult<C extends MatchCandidate = MatchCandidate> {
  verdict: MatchVerdict;
  /** Best first; rejected candidates (score 0) are dropped. */
  ranked: ScoredCandidate<C>[];
}

/** Version words that make a different recording; each penalised once when the Spotify side lacks it. */
const VERSION_WORDS: readonly RegExp[] = [
  /\blive\b/,
  /\bcover\b/,
  /\bkaraoke\b/,
  /\bsped up\b|\bspeed up\b/,
  /\bslowed\b/,
  /\bnightcore\b/,
  /\binstrumental\b/,
  /\bremix\b/,
  /\bacoustic\b/,
  /\b8d\b/,
  /\breverb\b/,
];

/** Spotify suffixes that name the same recording: "- Remastered 2011", "- Radio Edit", "- Mono". */
function stripSpotifySuffix(title: string): string {
  return title.replace(/\s[-–]\s[^-–]*\b(remaster(ed)?|version|edit|mono|stereo|mix)\b[^-–]*$/i, (whole) =>
    /\b(live|remix|acoustic|instrumental)\b/i.test(whole) ? whole : '',
  );
}

/** Search query for a Spotify track: primary artist + title. */
export function matchQuery(track: ImportedTrack): string {
  const artist = track.artists[0] ?? track.artist;
  return `${artist} ${stripSpotifySuffix(track.title)}`.trim();
}

function durationScore(diffSec: number): number {
  if (diffSec <= DURATION_STRONG_SEC) return 1;
  if (diffSec <= DURATION_OK_SEC) return 0.8;
  // Linear from 0.8 at OK down to 0.4 at REJECT.
  return 0.8 - (0.4 * (diffSec - DURATION_OK_SEC)) / (DURATION_REJECT_SEC - DURATION_OK_SEC);
}

/** Scores one candidate against a Spotify track (0..1, 0 = rejected). */
export function scoreCandidate<C extends MatchCandidate>(track: ImportedTrack, candidate: C): ScoredCandidate<C> {
  const split = splitArtistTitle(candidate.title, candidate.artist);
  const candTitle = normalizeTitle(split.title);
  const candArtist = normalizeArtist(split.artist ?? candidate.artist);
  const wantTitle = normalizeTitle(stripSpotifySuffix(track.title));

  const title = Math.max(titleSimilarity(wantTitle, candTitle), titleSimilarity(wantTitle, normalizeTitle(candidate.title)));
  const artists = track.artists.length ? track.artists : [track.artist];
  const artist = Math.max(
    0,
    ...artists.map((a) => {
      const na = normalizeArtist(a);
      // The artist may only appear in the upload title ("Artist - Song" on a fan channel).
      const inTitle = na.length >= 3 && ` ${fold(candidate.title)} `.includes(` ${primaryArtist(na)} `) ? 0.85 : 0;
      return Math.max(artistSimilarity(na, candArtist), inTitle);
    }),
  );

  const wantSec = track.durationMs !== undefined ? track.durationMs / 1000 : undefined;
  let score: number;
  let durationMatch = false;
  if (wantSec !== undefined && candidate.durationSec !== undefined && candidate.durationSec > 0) {
    const diff = Math.abs(wantSec - candidate.durationSec);
    if (diff > DURATION_REJECT_SEC) return { candidate, score: 0, durationMatch: false };
    durationMatch = diff <= DURATION_OK_SEC;
    score = 0.5 * title + 0.3 * artist + 0.2 * durationScore(diff);
  } else {
    score = 0.6 * title + 0.4 * artist;
  }

  const spotifyText = fold(`${track.title} ${track.album ?? ''}`);
  const candText = fold(`${candidate.title} ${candidate.album ?? ''}`);
  for (const word of VERSION_WORDS) {
    if (word.test(candText) && !word.test(spotifyText)) score -= VERSION_PENALTY;
  }
  if (track.album && candidate.album && titleSimilarity(normalizeTitle(track.album), normalizeTitle(candidate.album)) >= 0.9) {
    score += 0.03;
  }
  return { candidate, score: Math.max(0, Math.min(1, score)), durationMatch };
}

/** Ranks candidates and classifies the best one. */
export function matchTrack<C extends MatchCandidate>(track: ImportedTrack, candidates: readonly C[]): MatchResult<C> {
  const ranked = candidates
    .map((c) => scoreCandidate(track, c))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || Number(b.durationMatch) - Number(a.durationMatch));
  const best = ranked[0];
  const verdict: MatchVerdict = !best
    ? 'unmatched'
    : best.score >= AUTO_ACCEPT_SCORE && best.durationMatch
      ? 'matched'
      : best.score >= REVIEW_SCORE
        ? 'review'
        : 'unmatched';
  return { verdict, ranked };
}
