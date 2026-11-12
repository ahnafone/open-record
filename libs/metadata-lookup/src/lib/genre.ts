/**
 * Genre tidy-up for catalogue results. Only merges known aliases (case-insensitive)
 * onto one canonical label; any other genre keeps its own text.
 */

/** Canonical label -> aliases. Matching is case-insensitive and treats "&" as "and". */
const ALIASES: Record<string, readonly string[]> = {
  'Hip-Hop': ['Hip-Hop/Rap', 'Hip Hop/Rap', 'Hip Hop', 'Rap', 'HipHop'],
  'R&B/Soul': ['R&B', 'RnB', 'R and B', 'Soul', 'Rhythm and Blues'],
  Electronic: ['Electronica', 'Dance/Electronic', 'Dance Electronic', 'EDM'],
  Alternative: ['Alt', 'Alt Rock', 'Alternative Rock'],
  Rock: ['Rock & Roll', 'Rock and Roll', 'Rock n Roll'],
  Pop: ['Pop Music'],
};

const CANONICAL = new Map<string, string>();
for (const [label, aliases] of Object.entries(ALIASES)) {
  for (const alias of [label, ...aliases]) CANONICAL.set(foldKey(alias), label);
}

/** Lowercase, "&" -> "and", whitespace collapsed. */
function foldKey(s: string): string {
  return s.toLowerCase().replace(/&/g, ' and ').replace(/\s+/g, ' ').trim();
}

/**
 * Trims, collapses whitespace and merges known genre aliases to one label
 * (e.g. "Rap", "hip hop" -> "Hip-Hop"; "RnB" -> "R&B/Soul"). Unknown genres keep
 * their text as given (e.g. "K-Pop"). Blank or missing input gives undefined.
 */
export function normalizeGenre(raw: string | undefined): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const text = raw.trim().replace(/\s+/g, ' ');
  if (!text) return undefined;
  return CANONICAL.get(foldKey(text)) ?? text;
}
