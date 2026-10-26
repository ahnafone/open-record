import {
  artistSimilarity,
  fold,
  normalizeArtist,
  normalizeTitle,
  primaryArtist,
  romanize,
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

/**
 * Alternative titles / artist names for a track (e.g. catalogue aliases in
 * other scripts or languages). Scores take the best form on each side.
 */
export interface MatchAliases {
  titles: string[];
  artists: string[];
}

export type MatchVerdict = 'matched' | 'review' | 'unmatched';

export interface ScoredCandidate<C extends MatchCandidate = MatchCandidate> {
  candidate: C;
  /** 0..1. */
  score: number;
  /** Duration known on both sides and within DURATION_OK_SEC. */
  durationMatch: boolean;
  /** Best title similarity (0..1) over all compared forms, before any cross-script credit. */
  titleScore: number;
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
  /\boff vocal\b/,
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

const CROSS_SCRIPT_TITLE = 0.8;
/**
 * Cross-script credit when the duration is only loosely close (e.g. an official MV
 * with a short intro): enough for review, never for auto-accept.
 */
const CROSS_SCRIPT_TITLE_LOOSE = 0.6;

function hasLatin(s: string): boolean {
  return /\p{Script=Latin}/u.test(s);
}

const BRACKETED = /[([{【「『]([^)\]}】」』]*)[)\]}】」』]/g;

/**
 * "シャッター (Shutter)" style uploads: the text outside the brackets and each
 * bracket in the other script (Latin vs not), as alternative titles.
 */
function scriptVariants(s: string): string[] {
  const outside = s.replace(BRACKETED, ' ');
  const other = [...s.matchAll(BRACKETED)]
    .map((m) => m[1])
    .filter((inner) => /\p{L}/u.test(inner) && hasLatin(inner) !== hasLatin(outside));
  return other.length ? [outside, ...other] : [];
}

/** Distinct non-empty normalised forms of each input, plus their romanised forms. */
function forms(inputs: readonly string[], normalize: (s: string) => string): string[] {
  const out = new Set<string>();
  for (const raw of inputs) {
    for (const f of [normalize(raw), normalize(romanize(raw))]) if (f) out.add(f);
  }
  return [...out];
}

/** Scores one candidate against a Spotify track (0..1, 0 = rejected). */
export function scoreCandidate<C extends MatchCandidate>(
  track: ImportedTrack,
  candidate: C,
  aliases?: MatchAliases,
): ScoredCandidate<C> {
  const split = splitArtistTitle(candidate.title, candidate.artist);
  const candTitle = normalizeTitle(split.title);
  const wantTitle = normalizeTitle(stripSpotifySuffix(track.title));

  // Wanted titles: the Spotify title and any aliases, each also romanised.
  const wantTitles = forms([track.title, ...(aliases?.titles ?? [])].map(stripSpotifySuffix), normalizeTitle);
  // "Original - Translation" uploads: any dash-separated part may be the title.
  const parts = candidate.title.split(/\s+[-–—|]\s+/);
  const candTitles = forms(
    [split.title, candidate.title, ...parts].flatMap((t) => [t, ...scriptVariants(t)]),
    normalizeTitle,
  );
  let title = 0;
  for (const w of wantTitles) for (const c of candTitles) title = Math.max(title, titleSimilarity(w, c));
  // The same song titled in another script (Japanese vs romaji/English). Text can't
  // compare, so credit it below; the artist and duration checks below decide.
  const titleScore = title;
  const crossScript = hasLatin(wantTitle) !== hasLatin(candTitle) && title < CROSS_SCRIPT_TITLE;
  const wantArtists = forms(
    [...(track.artists.length ? track.artists : [track.artist]), ...(aliases?.artists ?? [])],
    normalizeArtist,
  );
  const candArtists = forms([split.artist ?? candidate.artist], normalizeArtist);
  const candTitleText = forms([candidate.title], fold).map((t) => ` ${t} `);
  const artist = Math.max(
    0,
    ...wantArtists.map((na) => {
      // The artist may only appear in the upload title ("Artist - Song" on a fan channel).
      const pa = primaryArtist(na);
      const inTitle = na.length >= 3 && candTitleText.some((t) => t.includes(` ${pa} `)) ? 0.85 : 0;
      return Math.max(inTitle, ...candArtists.map((ca) => artistSimilarity(na, ca)));
    }),
  );

  const wantSec = track.durationMs !== undefined ? track.durationMs / 1000 : undefined;
  let score: number;
  let durationMatch = false;
  if (wantSec !== undefined && candidate.durationSec !== undefined && candidate.durationSec > 0) {
    const diff = Math.abs(wantSec - candidate.durationSec);
    if (diff > DURATION_REJECT_SEC) return { candidate, score: 0, durationMatch: false, titleScore };
    durationMatch = diff <= DURATION_OK_SEC;
    if (crossScript && artist >= 0.9 && durationMatch) {
      title = diff <= DURATION_STRONG_SEC ? CROSS_SCRIPT_TITLE : Math.max(title, CROSS_SCRIPT_TITLE_LOOSE);
    }
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
  return { candidate, score: Math.max(0, Math.min(1, score)), durationMatch, titleScore };
}

/** Ranks candidates and classifies the best one. */
export function matchTrack<C extends MatchCandidate>(
  track: ImportedTrack,
  candidates: readonly C[],
  aliases?: MatchAliases,
): MatchResult<C> {
  const ranked = candidates
    .map((c) => scoreCandidate(track, c, aliases))
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
