import { parseCsv } from './csv';
import { dedupeTracks, makeTrack, splitArtists } from './tracks';
import type { ImportedPlaylist, ParsedImport } from './types';

/** Thrown for files that are not a recognised Spotify export. `message` is user-facing. */
export class ImportFormatError extends Error {
  override name = 'ImportFormatError';
}

// ---- Exportify CSV ---------------------------------------------------------

/** Header names (lowercased) per field; first present wins. */
const CSV_COLUMNS = {
  uri: ['track uri', 'spotify uri', 'uri'],
  title: ['track name', 'name', 'title'],
  artists: ['artist name(s)', 'artist names', 'artist name', 'artist', 'artists'],
  album: ['album name', 'album'],
  durationMs: ['duration (ms)', 'track duration (ms)', 'duration_ms'],
  isrc: ['isrc'],
  addedAt: ['added at', 'added_at'],
} as const;

/**
 * Parses an Exportify CSV (one playlist per file). `name` becomes the
 * playlist name (pass the file name; ".csv" and "_" are tidied).
 */
export function parseExportifyCsv(text: string, name: string): ImportedPlaylist {
  const [header, ...rows] = parseCsv(text);
  if (!header) throw new ImportFormatError('This CSV file is empty.');
  const cols = header.map((h) => h.trim().toLowerCase());
  const col = (names: readonly string[]) => {
    for (const n of names) {
      const i = cols.indexOf(n);
      if (i >= 0) return i;
    }
    return -1;
  };
  const at = {
    uri: col(CSV_COLUMNS.uri),
    title: col(CSV_COLUMNS.title),
    artists: col(CSV_COLUMNS.artists),
    album: col(CSV_COLUMNS.album),
    durationMs: col(CSV_COLUMNS.durationMs),
    isrc: col(CSV_COLUMNS.isrc),
    addedAt: col(CSV_COLUMNS.addedAt),
  };
  if (at.title < 0 || at.artists < 0) {
    throw new ImportFormatError('This CSV does not look like an Exportify export (no "Track Name" / "Artist Name(s)" columns).');
  }
  const get = (row: string[], i: number) => (i >= 0 ? row[i] : undefined);
  const tracks = rows.flatMap((row) => {
    const t = makeTrack({
      title: get(row, at.title),
      artists: splitArtists(get(row, at.artists)),
      album: get(row, at.album),
      durationMs: get(row, at.durationMs),
      isrc: get(row, at.isrc),
      uri: get(row, at.uri),
      addedAt: get(row, at.addedAt),
    });
    return t ? [t] : [];
  });
  return { name: playlistName(name), tracks: dedupeTracks(tracks) };
}

/** "liked_songs.csv" -> "liked songs"; "Road_Trip.csv" -> "Road Trip". */
function playlistName(fileName: string): string {
  const base = fileName.replace(/^.*[\\/]/, '').replace(/\.csv$/i, '');
  return base.replace(/_/g, ' ').replace(/\s+/g, ' ').trim() || 'Imported playlist';
}

/**
 * True for Exportify's Liked Songs export file name: `Liked_Songs.csv`
 * (older exports) or `liked.csv` (Export All), with an optional copy suffix
 * such as `liked (1).csv`.
 */
export function isLikedSongsFile(fileName: string): boolean {
  return isLikedSongsName(fileName.replace(/^.*[\\/]/, '').replace(/\.csv$/i, ''));
}

/** True for a playlist name that stands for Liked Songs ("liked", "Liked Songs", "liked_songs (2)"). */
export function isLikedSongsName(name: string): boolean {
  const n = name.trim();
  return /^liked[\s_-]*songs/i.test(n) || /^liked(?:[\s_-]*\(?\d+\)?)?$/i.test(n);
}

// ---- Spotify "Download your data" JSON -------------------------------------

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/**
 * Parses one file of Spotify's account data download: `Playlist*.json`
 * (`playlists[].items[].track`) or `YourLibrary.json` (`tracks[]`, as Liked
 * Songs). Podcast episodes and local files without names are skipped.
 */
export function parseDataDownloadJson(text: string): ParsedImport {
  let data: unknown;
  try {
    data = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    throw new ImportFormatError('This file is not valid JSON.');
  }
  if (!isObj(data) || (!Array.isArray(data['playlists']) && !Array.isArray(data['tracks']))) {
    throw new ImportFormatError(
      'This JSON is not a Spotify data export. Use Playlist1.json or YourLibrary.json from the unzipped download.',
    );
  }
  const playlists = arr(data['playlists']).flatMap((p): ImportedPlaylist[] => {
    if (!isObj(p)) return [];
    const tracks = arr(p['items']).flatMap((item) => {
      const t = isObj(item) && isObj(item['track']) ? item['track'] : null;
      const added = isObj(item) ? item['addedDate'] : undefined;
      const track =
        t &&
        makeTrack({
          title: t['trackName'],
          artists: splitArtistField(t['artistName']),
          album: t['albumName'],
          uri: t['trackUri'],
          addedAt: added,
        });
      return track ? [track] : [];
    });
    const name = typeof p['name'] === 'string' && p['name'].trim() ? p['name'].trim() : 'Imported playlist';
    return [{ name, tracks: dedupeTracks(tracks) }];
  });
  const liked = arr(data['tracks']).flatMap((t) => {
    const track =
      isObj(t) &&
      makeTrack({ title: t['track'], artists: splitArtistField(t['artist']), album: t['album'], uri: t['uri'] });
    return track ? [track] : [];
  });
  return { playlists, liked: dedupeTracks(liked) };
}

/** The data download lists one artist string per track; keep it whole. */
function splitArtistField(v: unknown): string[] {
  return typeof v === 'string' && v.trim() ? [v.trim()] : [];
}

// ---- Files -----------------------------------------------------------------

/**
 * Parses one picked export file by extension: `.csv` (Exportify; Liked Songs
 * when named so) or `.json` (data download). Throws `ImportFormatError` with a
 * user-facing message otherwise.
 */
export function parseImportFile(fileName: string, text: string): ParsedImport {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.csv')) {
    const playlist = parseExportifyCsv(text, fileName);
    return isLikedSongsFile(fileName) ? { playlists: [], liked: playlist.tracks } : { playlists: [playlist], liked: [] };
  }
  if (lower.endsWith('.json')) return parseDataDownloadJson(text);
  if (lower.endsWith('.zip')) {
    throw new ImportFormatError('Unzip the Spotify download first, then pick Playlist1.json or YourLibrary.json.');
  }
  throw new ImportFormatError('Pick an Exportify .csv file or a .json file from your Spotify data download.');
}

/** Combines several parsed files: playlists are concatenated, liked songs merged and deduped. */
export function mergeImports(parts: readonly ParsedImport[]): ParsedImport {
  return {
    playlists: parts.flatMap((p) => p.playlists),
    liked: dedupeTracks(parts.flatMap((p) => p.liked)),
  };
}

/** Total tracks across playlists and liked songs (with repeats). */
export function countTracks(parsed: ParsedImport): number {
  return parsed.liked.length + parsed.playlists.reduce((n, p) => n + p.tracks.length, 0);
}
