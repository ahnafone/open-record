import type { Track } from '@open-record/models';

/** Provider id; local track ids are `local:<key>`. */
export const LOCAL_PROVIDER_ID = 'local';

const ID_PREFIX = `${LOCAL_PROVIDER_ID}:`;

export function localTrackId(key: string): string {
  return ID_PREFIX + key;
}

/** Storage key from a local track id, or `null` if the id is not a local one. */
export function localKeyFromTrackId(trackId: string): string | null {
  if (!trackId.startsWith(ID_PREFIX)) return null;
  const key = trackId.slice(ID_PREFIX.length);
  return /^[A-Za-z0-9-]+$/.test(key) ? key : null;
}

/** Subset of music-metadata's result we map (kept structural so this file stays dependency free). */
export interface LocalTagInfo {
  common: {
    title?: string;
    artist?: string;
    artists?: string[];
    albumartist?: string;
    album?: string;
    year?: number;
    genre?: string[];
  };
  format: { duration?: number };
}

export interface LocalFileInfo {
  key: string;
  fileName: string;
  sourceFile: string;
  sizeBytes: number;
  coverPath?: string;
}

export const UNKNOWN_ARTIST = 'Unknown artist';

function clean(value: string | undefined | null): string | undefined {
  const v = value?.replace(/\s+/g, ' ').trim();
  return v ? v : undefined;
}

/**
 * Best-effort title/artist from a file name: strips the extension, leading
 * track numbers ("01 - ", "07. ") and splits "Artist - Title".
 */
export function parseFileName(fileName: string): { title: string; artist?: string } {
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  let stem = base.replace(/\.[A-Za-z0-9]{1,5}$/, '').replace(/_/g, ' ');
  stem = stem.replace(/^\s*\d{1,3}\s*[-.)]\s*/, '');
  const parts = stem.split(/\s+[-–—]\s+/);
  if (parts.length >= 2) {
    const artist = clean(parts[0]);
    const title = clean(parts.slice(1).join(' - '));
    if (artist && title) return { title, artist };
  }
  return { title: clean(stem) ?? clean(base) ?? 'Untitled' };
}

/** Pure mapping from tags (if any) + stored file info to a Track; tags win, the file name fills gaps. */
export function toLocalTrack(file: LocalFileInfo, tags?: LocalTagInfo | null): Track {
  const c = tags?.common ?? {};
  const fromName = parseFileName(file.fileName);
  const artist = clean(c.artist) ?? clean(c.artists?.join(', ')) ?? clean(c.albumartist);
  const duration = tags?.format.duration;
  const genre = clean(c.genre?.[0]);

  const track: Track = {
    id: localTrackId(file.key),
    providerId: LOCAL_PROVIDER_ID,
    title: clean(c.title) ?? fromName.title,
    artist: artist ?? fromName.artist ?? UNKNOWN_ARTIST,
    sourceFile: file.sourceFile,
    sizeBytes: file.sizeBytes,
  };
  const album = clean(c.album);
  if (album) track.album = album;
  if (c.year && Number.isFinite(c.year) && c.year > 0) track.year = c.year;
  if (genre) track.genre = genre;
  if (duration && Number.isFinite(duration) && duration > 0) track.durationSec = Math.round(duration);
  if (file.coverPath) track.coverPath = file.coverPath;
  return track;
}

const AUDIO_EXT_BY_MIME: Record<string, string> = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/webm': 'webm',
};

const MIME_BY_EXT: Record<string, string> = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  flac: 'audio/flac',
  wav: 'audio/wav',
  webm: 'audio/webm',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
};

/** Lower-case extension (no dot) of a file name, if it has a sane one. */
export function fileExtension(name: string): string | undefined {
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(name);
  return m?.[1]?.toLowerCase();
}

export function audioExtension(fileName: string, mimeType?: string): string {
  return fileExtension(fileName) ?? (mimeType && AUDIO_EXT_BY_MIME[mimeType.toLowerCase()]) ?? 'audio';
}

export function imageExtension(mimeType: string): string {
  const sub = mimeType.toLowerCase().split('/')[1] ?? '';
  return sub === 'jpeg' ? 'jpg' : /^[a-z0-9]{1,5}$/.test(sub) ? sub : 'img';
}

export function mimeFromName(name: string): string | undefined {
  const ext = fileExtension(name);
  return ext ? MIME_BY_EXT[ext] : undefined;
}
