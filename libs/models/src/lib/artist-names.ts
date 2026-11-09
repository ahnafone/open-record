/** Latin combining marks (U+0300–U+036F). Other marks (e.g. Japanese dakuten) are kept. */
const LATIN_MARKS = /[̀-ͯ]/g;

/**
 * Lower-case, Latin-accent-free, single-spaced form used for every comparison.
 * Only Latin combining marks are stripped, so kana, Hangul and other scripts
 * keep their meaning (が stays distinct from か).
 */
function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(LATIN_MARKS, '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Bands whose names contain a separator and must never be split. Folded on use. */
const KEEP_WHOLE_NAMES = [
  'Simon & Garfunkel',
  'Earth, Wind & Fire',
  'Years & Years',
  'Hall & Oates',
  'Mumford & Sons',
  'Brooks & Dunn',
  'Crosby, Stills & Nash',
  'Cheech & Chong',
  'Big & Rich',
  'Sly & the Family Stone',
  'Echo & the Bunnymen',
  'Katrina & the Waves',
  'Martha & the Vandellas',
  'Hootie & the Blowfish',
  'Marina & the Diamonds',
  'Belle & Sebastian',
  'Zager & Evans',
  'Tyler, The Creator',
  'Nick Cave & the Bad Seeds',
  'Sonny & Cher',
  'Of Mice & Men',
  'Dead & Company',
  'Matt & Kim',
  'Ike & Tina Turner',
  'Gladys Knight & the Pips',
  'Kool & the Gang',
  'Edward Sharpe & the Magnetic Zeros',
  'Iron & Wine',
  'Angus & Julia Stone',
  'Prince & the Revolution',
  'Bob Marley & the Wailers',
  'Smokey Robinson & the Miracles',
  'Diana Ross & the Supremes',
  'Huey Lewis & the News',
  'Tom Petty & the Heartbreakers',
  'Bruce Springsteen & the E Street Band',
  'Derek & the Dominos',
  'Florence & the Machine',
];

const KEEP_WHOLE = new Set(KEEP_WHOLE_NAMES.map(fold));

const UNKNOWN_ARTIST = 'unknown artist';

/** `(feat. X)` / `[ft X]` groups: the brackets are dropped, the feat. word stays as a separator. */
const FEAT_GROUP =
  /\s*[([]\s*((?:featuring|feat|ft)(?![\p{L}\p{N}])[^()[\]]*)[)\]]/giu;

/** Separators: comma, semicolon, ampersand, or a feat./ft./featuring word. */
const SEPARATOR =
  /\s*(?:[,;&]|(?<![\p{L}\p{N}])(?:featuring|feat|ft)(?![\p{L}\p{N}])\.?)\s*/giu;

/** Most pieces any kept-whole band spans; bounds the lookahead in `splitArtists`. */
const MAX_BAND_PIECES = Math.max(
  ...KEEP_WHOLE_NAMES.map((name) => name.split(SEPARATOR).length),
);

/**
 * Split a credited artist string into individual artist names. Splits on
 * `,` `;` `&` and feat./ft./featuring (also inside parentheses). Known bands
 * whose names contain a separator stay whole. Names are trimmed, empty ones
 * dropped and duplicates (by {@link artistKey}) removed, keeping first-seen
 * spelling and order. `'Unknown artist'` yields `[]`.
 */
export function splitArtists(artist: string): string[] {
  const text = artist.replace(FEAT_GROUP, ' $1').trim();
  if (!text || fold(text) === UNKNOWN_ARTIST) return [];

  // Piece ranges between separators (offsets into `text`).
  const ranges: [number, number][] = [];
  let from = 0;
  for (const match of text.matchAll(SEPARATOR)) {
    const at = match.index ?? 0;
    ranges.push([from, at]);
    from = at + match[0].length;
  }
  ranges.push([from, text.length]);

  const names: string[] = [];
  for (let i = 0; i < ranges.length;) {
    // Longest run of pieces (up to MAX_BAND_PIECES) that folds to a kept-whole band; otherwise one piece.
    let last = i;
    for (
      let j = Math.min(ranges.length - 1, i + MAX_BAND_PIECES - 1);
      j > i;
      j--
    ) {
      if (KEEP_WHOLE.has(fold(text.slice(ranges[i][0], ranges[j][1])))) {
        last = j;
        break;
      }
    }
    const name = text.slice(ranges[i][0], ranges[last][1]).trim();
    if (name) names.push(name);
    i = last + 1;
  }

  const seen = new Set<string>();
  return names.filter((name) => {
    const key = artistKey(name);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Stable identity of an artist name: diacritic-free, lower-case, single-spaced. */
export function artistKey(name: string): string {
  return fold(name);
}

/** Stable identity of an album: its primary artist plus its folded title. */
export function albumKey(album: string, primaryArtistName: string): string {
  return `${artistKey(primaryArtistName)}::${fold(album)}`;
}
