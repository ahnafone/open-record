/**
 * Text normalisation and similarity helpers for matching a downloaded track
 * (often a messy YouTube title) against store catalogue entries.
 */

/** Bracketed segments containing any of these words are upload noise, not part of the title. */
const NOISE_WORDS =
  /\b(official|video|audio|lyrics?|lyric video|visuali[sz]er|music video|mv|hd|hq|4k|1080p|720p|explicit|clean|full song|topic|color coded|subtitulad[oa]|letra)\b/i;

/** Removes "(Official Video)", "[Lyrics]", "【MV】" style segments that only contain noise words. */
function stripNoiseBrackets(s: string): string {
  return s.replace(/[([{【「]([^)\]}】」]*)[)\]}】」]/g, (whole, inner: string) =>
    NOISE_WORDS.test(inner) || /^\s*(feat\.?|ft\.?|featuring)\s/i.test(inner) ? ' ' : whole,
  );
}

/** Removes trailing "feat. X" / "ft. X" / "featuring X" (outside brackets). */
function stripFeat(s: string): string {
  return s.replace(/\s(feat\.?|ft\.?|featuring)\s.*$/i, ' ');
}

/** Lowercase, strip diacritics and punctuation, collapse whitespace. */
export function fold(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Drops bracketed translations/transliterations with no Latin letters, e.g.
 * "Cheye Dekho (চেয়ে দেখো)", when the rest of the title is Latin.
 */
function stripScriptBrackets(s: string): string {
  const BRACKET = /[([{【「]([^)\]}】」]*)[)\]}】」]/g;
  if (!/\p{Script=Latin}/u.test(s.replace(BRACKET, ' '))) return s;
  return s.replace(BRACKET, (whole, inner: string) =>
    /\p{L}/u.test(inner) && !/\p{Script=Latin}/u.test(inner) ? ' ' : whole,
  );
}

/** Normalises a track title: drops upload noise and featured artists. */
export function normalizeTitle(title: string): string {
  let s = stripScriptBrackets(stripNoiseBrackets(title));
  s = stripFeat(s);
  // Bare trailing noise without brackets, e.g. "Song - Official Video" / "Song | Lyrics".
  s = s.replace(/\s[-|]\s*(official.*|lyrics?.*|audio|video|hd|hq)$/i, ' ');
  return fold(s);
}

/** Normalises an artist name: drops "- Topic", "VEVO", "Official" and featured artists. */
export function normalizeArtist(artist: string): string {
  let s = artist.replace(/\s*-\s*topic\s*$/i, '');
  s = s.replace(/vevo\s*$/i, '');
  s = s.replace(/\s*(official|officiel)(\s+(channel|music))?\s*$/i, '');
  s = stripFeat(stripNoiseBrackets(s));
  return fold(s);
}

/** First credited artist ("A & B", "A, B", "A x B" -> "a"). Input must be normalised. */
export function primaryArtist(normalized: string): string {
  return normalized.split(/\s(?:and|x|with|vs)\s|,/)[0].trim();
}

function bigrams(s: string): Map<string, number> {
  const out = new Map<string, number>();
  const t = s.replace(/\s/g, '');
  for (let i = 0; i < t.length - 1; i++) {
    const g = t.slice(i, i + 2);
    out.set(g, (out.get(g) ?? 0) + 1);
  }
  return out;
}

/** Sørensen-Dice coefficient over character bigrams (0..1). Inputs should be normalised. */
export function dice(a: string, b: string): number {
  if (a === b) return a.length ? 1 : 0;
  const x = a.replace(/\s/g, '');
  const y = b.replace(/\s/g, '');
  if (x.length < 2 || y.length < 2) return x === y ? 1 : 0;
  const ga = bigrams(a);
  const gb = bigrams(b);
  let overlap = 0;
  for (const [g, n] of ga) overlap += Math.min(n, gb.get(g) ?? 0);
  return (2 * overlap) / (x.length - 1 + (y.length - 1));
}

/** Similarity of two normalised titles (0..1). */
export function titleSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  return dice(a, b);
}

/** Similarity of two normalised artist strings, tolerant of extra credited artists (0..1). */
export function artistSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const pa = primaryArtist(a);
  const pb = primaryArtist(b);
  const contained =
    (` ${b} `.includes(` ${pa} `) && pa.length >= 3) || (` ${a} `.includes(` ${pb} `) && pb.length >= 3);
  return Math.max(dice(a, b), dice(pa, pb), contained ? 0.9 : 0);
}

/**
 * Splits a YouTube-style "Artist - Title" upload title. If the left side
 * resembles the given artist (or no artist is known), returns both parts;
 * otherwise returns the input unchanged.
 */
export function splitArtistTitle(title: string, artist?: string): { title: string; artist?: string } {
  const m = /^(.+?)\s+[-–—]\s+(.+)$/.exec(title);
  if (!m) return { title, artist };
  const [, left, right] = m;
  if (!artist) return { title: right, artist: left };
  const na = normalizeArtist(artist);
  if (artistSimilarity(normalizeArtist(left), na) >= 0.7) return { title: right, artist };
  return { title, artist };
}
