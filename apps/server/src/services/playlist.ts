import {
  MAX_PLAYLIST_ENTRIES,
  type RemotePlaylist,
  type RemotePlaylistEntry,
} from '@open-record/models';
import { MAX_URL_LENGTH, UrlRejectedError } from './url-guard';
import {
  normalizeArtist,
  runYtDlpJson,
  toSearchResult,
  YtDlpError,
  type YtDlpInfo,
} from './ytdlp';

/** Hosts a YouTube link may use. Anything else is refused before yt-dlp runs. */
const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com']);
const MUSIC_HOST = 'music.youtube.com';
/** Short share links: `youtu.be/<video id>` (songs only, or with `list=`). */
const SHORT_HOST = 'youtu.be';
const LIST_ID = /^[A-Za-z0-9_-]{2,64}$/;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
/** Account-only lists (Liked videos, Watch later): never public. */
const PRIVATE_LISTS = new Set(['LL', 'WL', 'LM']);
/** Placeholder titles of entries that cannot be played. */
const UNAVAILABLE_TITLE = /^\[(?:private|deleted|unavailable) video\]$/i;

export interface PlaylistTarget {
  kind: 'playlist';
  id: string;
  site: 'youtube' | 'ytmusic';
  /** Canonical URL rebuilt from the id: no user-supplied host or path reaches yt-dlp. */
  url: string;
}

export interface SongTarget {
  kind: 'song';
  /** The 11-character video id. */
  id: string;
  site: 'youtube' | 'ytmusic';
  /** Canonical watch URL rebuilt from the id (never `list=`, never user-supplied). */
  url: string;
}

export type YoutubeTarget = PlaylistTarget | SongTarget;

/**
 * Strict allow-list for public YouTube links. Playlists: `youtube.com/playlist?list=`,
 * `watch?v=..&list=`, `music.youtube.com/playlist?list=` and
 * `music.youtube.com/browse/VL<id>`. Songs (no `list=`): `youtube.com/watch?v=`,
 * `music.youtube.com/watch?v=` and `youtu.be/<id>`. https/http only, no credentials
 * or port, YouTube hosts only, ids validated. Returns a canonical URL built from the
 * id, so the server never fetches a user-chosen host (SSRF-safe).
 */
export function parseYoutubeLink(raw: unknown): YoutubeTarget {
  if (typeof raw !== 'string' || !raw.trim()) throw new UrlRejectedError('url is required');
  const input = raw.trim();
  if (input.length > MAX_URL_LENGTH) throw new UrlRejectedError('url is too long');
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(input) ? input : `https://${input}`);
  } catch {
    throw new UrlRejectedError('url is not valid');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new UrlRejectedError('only http and https urls are allowed');
  }
  if (url.username || url.password) throw new UrlRejectedError('urls with credentials are not allowed');
  if (url.port) throw new UrlRejectedError('url host is not allowed');
  const host = url.hostname.toLowerCase();
  const music = host === MUSIC_HOST;
  const short = host === SHORT_HOST;
  if (!music && !short && !YOUTUBE_HOSTS.has(host)) {
    throw new UrlRejectedError('only YouTube and YouTube Music playlist or song links are supported');
  }
  const site = music ? 'ytmusic' : 'youtube';
  const base = music ? 'https://music.youtube.com' : 'https://www.youtube.com';
  const path = url.pathname.replace(/\/+$/, '') || '/';

  let listId = url.searchParams.get('list') ?? '';
  const browse = /^\/browse\/VL([A-Za-z0-9_-]+)\/?$/.exec(url.pathname);
  if (!listId && music && browse) listId = browse[1];
  if (listId) {
    const pathOk = path === '/playlist' || path === '/watch' || (music && !!browse) || short;
    if (!pathOk) throw new UrlRejectedError('this link is not a playlist; copy the playlist link (with list=)');
    if (!LIST_ID.test(listId)) throw new UrlRejectedError('the playlist id is not valid');
    if (PRIVATE_LISTS.has(listId)) {
      throw new UrlRejectedError('that list is private to your account; make a public or unlisted copy and share its link');
    }
    return { kind: 'playlist', id: listId, site, url: `${base}/playlist?list=${encodeURIComponent(listId)}` };
  }

  // Single song: the id is in `v=` on watch pages, or the only path segment on youtu.be.
  let videoId: string | null = null;
  if (short) videoId = path.slice(1);
  else if (path === '/watch') videoId = url.searchParams.get('v') ?? '';
  if (videoId === null) {
    throw new UrlRejectedError('this link is not a playlist or song; copy the playlist (with list=) or song link');
  }
  if (!VIDEO_ID.test(videoId)) throw new UrlRejectedError('the video id is not valid');
  return { kind: 'song', id: videoId, site, url: `${base}/watch?v=${videoId}` };
}

interface PlaylistInfo extends YtDlpInfo {
  playlist_count?: number;
  channel?: string;
}

const clean = (s: unknown): string | undefined =>
  typeof s === 'string' && s.trim() ? s.trim() : undefined;

/** Maps one flat-playlist entry; null for private, deleted or malformed entries. */
export function toPlaylistEntry(e: YtDlpInfo, site: YoutubeTarget['site']): RemotePlaylistEntry | null {
  const id = clean(e.id);
  const originalTitle = clean(e.title);
  if (!id || !VIDEO_ID.test(id) || !originalTitle || UNAVAILABLE_TITLE.test(originalTitle)) return null;
  const base = site === 'ytmusic' ? 'https://music.youtube.com' : 'https://www.youtube.com';
  const url = `${base}/watch?v=${id}`;
  const result = toSearchResult({ ...e, webpage_url: url, url }, site);
  if (!result) return null;
  const entry: RemotePlaylistEntry = {
    id,
    url,
    site,
    title: result.title,
    artist: result.artist,
    originalTitle,
  };
  const uploader = normalizeArtist(clean(e.uploader) ?? clean(e.channel)) || undefined;
  if (uploader) entry.uploader = uploader;
  const album = clean(e.album);
  if (album) entry.album = album;
  if (result.durationSec !== undefined) entry.durationSec = result.durationSec;
  entry.thumbnailUrl = result.thumbnailUrl ?? `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
  return entry;
}

/** Clear, client-safe messages for the usual playlist or song failures. */
function linkError(err: unknown, noun: 'playlist' | 'song'): unknown {
  if (!(err instanceof YtDlpError) || err.status !== 502) return err;
  const msg = err.message.toLowerCase();
  if (/private|sign in|members[- ]only|login/.test(msg)) {
    return new YtDlpError(`This ${noun} is private. Make it public or unlisted, then try again.`, 403);
  }
  if (/does not exist|not exist|unavailable|not found|404|no longer available|been removed/.test(msg)) {
    return new YtDlpError(`${capitalize(noun)} not found. Check the link, or it may have been deleted.`, 404);
  }
  return err;
}

const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** A public playlist's entries via `yt-dlp -J --flat-playlist` (metadata only, nothing is downloaded). */
export async function fetchPlaylist(target: PlaylistTarget): Promise<RemotePlaylist> {
  let info: PlaylistInfo;
  try {
    info = (await runYtDlpJson([
      '-J',
      '--flat-playlist',
      '--playlist-end',
      String(MAX_PLAYLIST_ENTRIES + 1),
      '--',
      target.url,
    ])) as PlaylistInfo;
  } catch (err) {
    throw linkError(err, 'playlist');
  }
  if (info._type !== 'playlist' || !Array.isArray(info.entries)) {
    throw new YtDlpError('Playlist not found. Check the link, or it may have been deleted.', 404);
  }
  const raw = info.entries.slice(0, MAX_PLAYLIST_ENTRIES);
  const seen = new Set<string>();
  const entries: RemotePlaylistEntry[] = [];
  let unavailable = 0;
  for (const e of raw) {
    const entry = e ? toPlaylistEntry(e, target.site) : null;
    if (!entry) unavailable++;
    else if (!seen.has(entry.id)) {
      seen.add(entry.id);
      entries.push(entry);
    }
  }
  const count = typeof info.playlist_count === 'number' ? info.playlist_count : info.entries.length;
  const playlist: RemotePlaylist = {
    id: target.id,
    title: (clean(info.title) ?? 'YouTube playlist').slice(0, 200),
    url: target.url,
    site: target.site,
    entries,
    unavailable,
    truncated: info.entries.length > MAX_PLAYLIST_ENTRIES || count > MAX_PLAYLIST_ENTRIES,
  };
  const uploader = normalizeArtist(clean(info.uploader) ?? clean(info.channel));
  if (uploader) playlist.uploader = uploader;
  return playlist;
}

/**
 * One song's metadata via `yt-dlp -J --no-playlist` (nothing is downloaded), returned
 * as a single-entry `RemotePlaylist` with `single: true` so the app adds the song to
 * the library without creating a playlist.
 */
export async function fetchSong(target: SongTarget): Promise<RemotePlaylist> {
  let info: YtDlpInfo;
  try {
    info = await runYtDlpJson(['-J', '--no-playlist', '--', target.url]);
  } catch (err) {
    throw linkError(err, 'song');
  }
  const entry = info._type === 'playlist' ? null : toPlaylistEntry({ ...info, id: target.id }, target.site);
  if (!entry) {
    throw new YtDlpError('This song is private, deleted or unavailable.', 404);
  }
  return {
    id: target.id,
    title: entry.title,
    url: target.url,
    site: target.site,
    entries: [entry],
    unavailable: 0,
    truncated: false,
    single: true,
  };
}
