/**
 * Minimal offline romaniser used as a secondary comparison form, so kana,
 * Hangul and Cyrillic titles/artists compare against romanised uploads
 * without a network lookup. Deliberately small (no dependency): Hepburn-style
 * kana, Revised Romanization Hangul (no sound-change rules) and a common
 * Cyrillic scheme. Kanji/Hanzi and other scripts pass through unchanged.
 */

const HIRAGANA: Record<string, string> = {
  あ: 'a', い: 'i', う: 'u', え: 'e', お: 'o',
  か: 'ka', き: 'ki', く: 'ku', け: 'ke', こ: 'ko',
  が: 'ga', ぎ: 'gi', ぐ: 'gu', げ: 'ge', ご: 'go',
  さ: 'sa', し: 'shi', す: 'su', せ: 'se', そ: 'so',
  ざ: 'za', じ: 'ji', ず: 'zu', ぜ: 'ze', ぞ: 'zo',
  た: 'ta', ち: 'chi', つ: 'tsu', て: 'te', と: 'to',
  だ: 'da', ぢ: 'ji', づ: 'zu', で: 'de', ど: 'do',
  な: 'na', に: 'ni', ぬ: 'nu', ね: 'ne', の: 'no',
  は: 'ha', ひ: 'hi', ふ: 'fu', へ: 'he', ほ: 'ho',
  ば: 'ba', び: 'bi', ぶ: 'bu', べ: 'be', ぼ: 'bo',
  ぱ: 'pa', ぴ: 'pi', ぷ: 'pu', ぺ: 'pe', ぽ: 'po',
  ま: 'ma', み: 'mi', む: 'mu', め: 'me', も: 'mo',
  や: 'ya', ゆ: 'yu', よ: 'yo',
  ら: 'ra', り: 'ri', る: 'ru', れ: 're', ろ: 'ro',
  わ: 'wa', ゐ: 'i', ゑ: 'e', を: 'o', ん: 'n', ゔ: 'vu',
  ぁ: 'a', ぃ: 'i', ぅ: 'u', ぇ: 'e', ぉ: 'o', ゃ: 'ya', ゅ: 'yu', ょ: 'yo', ゎ: 'wa',
};
const SMALL_Y = new Set(['ゃ', 'ゅ', 'ょ']);
const SMALL_VOWEL = new Set(['ぁ', 'ぃ', 'ぅ', 'ぇ', 'ぉ']);

/** Katakana (U+30A1..U+30F6) to hiragana; everything else unchanged. */
function toHiragana(ch: string): string {
  const c = ch.charCodeAt(0);
  return c >= 0x30a1 && c <= 0x30f6 ? String.fromCharCode(c - 0x60) : ch;
}

function romanizeKana(chars: string[], i: number): { text: string; next: number } | null {
  const h = toHiragana(chars[i]);
  if (h === 'っ') {
    // Sokuon doubles the next consonant ("kk", "tch").
    const rest = romanizeKana(chars, i + 1);
    if (!rest || !/^[a-z]/.test(rest.text) || /^[aiueon]/.test(rest.text)) return { text: '', next: i + 1 };
    const lead = rest.text.startsWith('ch') ? 't' : rest.text[0];
    return { text: lead + rest.text, next: rest.next };
  }
  const base = HIRAGANA[h];
  if (base === undefined) return null;
  const after = chars[i + 1] !== undefined ? toHiragana(chars[i + 1]) : '';
  if (SMALL_Y.has(after) && base.length > 1 && base.endsWith('i')) {
    const stem = base.slice(0, -1);
    const vowel = HIRAGANA[after].slice(1);
    return { text: /^(sh|ch|j)$/.test(stem) ? stem + vowel : `${stem}y${vowel}`, next: i + 2 };
  }
  if (SMALL_VOWEL.has(after)) {
    // ファ fa, ティ ti, ウィ wi, ヴァ va, チェ che.
    const stem = base.replace(/[aiueo]$/, '') || 'w';
    return { text: stem + HIRAGANA[after], next: i + 2 };
  }
  return { text: base, next: i + 1 };
}

const HANGUL_INITIAL = ['g', 'kk', 'n', 'd', 'tt', 'r', 'm', 'b', 'pp', 's', 'ss', '', 'j', 'jj', 'ch', 'k', 't', 'p', 'h'];
const HANGUL_MEDIAL = [
  'a', 'ae', 'ya', 'yae', 'eo', 'e', 'yeo', 'ye', 'o', 'wa', 'wae',
  'oe', 'yo', 'u', 'wo', 'we', 'wi', 'yu', 'eu', 'ui', 'i',
];
const HANGUL_FINAL = [
  '', 'k', 'k', 'k', 'n', 'n', 'n', 't', 'l', 'k', 'm', 'l', 'l', 'l',
  'p', 'l', 'm', 'p', 'p', 't', 't', 'ng', 't', 't', 'k', 't', 'p', 't',
];

function romanizeHangul(ch: string): string | null {
  const c = ch.charCodeAt(0) - 0xac00;
  if (c < 0 || c > 11171) return null;
  return HANGUL_INITIAL[Math.floor(c / 588)] + HANGUL_MEDIAL[Math.floor((c % 588) / 28)] + HANGUL_FINAL[c % 28];
}

const CYRILLIC: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'zh', з: 'z', и: 'i',
  й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't',
  у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ъ: '', ы: 'y', ь: '',
  э: 'e', ю: 'yu', я: 'ya', і: 'i', ї: 'yi', є: 'ye', ґ: 'g', ў: 'u', ђ: 'dj', ј: 'j',
  љ: 'lj', њ: 'nj', ћ: 'c', џ: 'dz', ѓ: 'gj', ќ: 'kj', ѕ: 'dz',
};

const NEEDS_ROMANIZING = /[ぁ-ヿ가-힣Ѐ-ӿ]/;

/**
 * Romanises kana, Hangul syllables and Cyrillic in `s` (lowercase output for
 * those parts); other characters are kept. Returns `s` unchanged when it has
 * none of those scripts. Feed the result to `fold`/`normalizeTitle`.
 */
export function romanize(s: string): string {
  const src = s.normalize('NFC');
  if (!NEEDS_ROMANIZING.test(src)) return s;
  const chars = [...src];
  let out = '';
  let prevKana = false;
  for (let i = 0; i < chars.length; ) {
    const ch = chars[i];
    const kana = romanizeKana(chars, i);
    if (kana) {
      out += kana.text;
      i = kana.next;
      prevKana = true;
      continue;
    }
    // Long-vowel mark: dropped, as in most casual romaji ("ルーム" -> "rumu").
    if (ch === 'ー' && prevKana) {
      i++;
      continue;
    }
    prevKana = false;
    const hangul = romanizeHangul(ch);
    if (hangul !== null) {
      out += hangul;
    } else {
      const lower = ch.toLowerCase();
      const cyr = CYRILLIC[lower];
      out += cyr === undefined ? ch : cyr;
    }
    i++;
  }
  return out;
}
