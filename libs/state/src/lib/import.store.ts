import { Injectable, computed, inject, signal } from '@angular/core';
import { MAX_ENRICH_BATCH, type EnrichMatch, type MetadataCandidate, type Track } from '@open-record/models';
import { MusicSourceRegistry } from '@open-record/music-source';
import { fold } from '@open-record/metadata-lookup';
import {
  isLikedSongsName,
  matchQuery,
  matchTrack,
  type MatchAliases,
  parseImportFile,
  toCsv,
  trackKey,
  type ImportedTrack,
  type MatchResult,
  type ParsedImport,
} from '@open-record/spotify-import';
import { SETTINGS_KEYS, StoragePort, type JsonValue } from '@open-record/storage';
import { ImportSessionsStore } from './import-sessions.store';
import { LibraryStore } from './library.store';
import { PlaylistsStore, PLAYLIST_NAME_MAX } from './playlists.store';
import { RemoteServerPort } from './ports';
import { busyRetryAfterSec, isAbort, remoteErrorMessage } from './remote-errors';
import { ENRICH_AUTO_ACCEPT, MetadataEnrichStore, toMetadataCandidates } from './metadata-enrich.store';

export type { MetadataCandidate } from '@open-record/models';
export type {
  ImportedPlaylist,
  ImportedTrack as SpotifyImportedTrack,
  ParsedImport,
} from '@open-record/spotify-import';

/** Provider id of unmatched Spotify placeholders (track ids are `spotify:<id>`). */
export const SPOTIFY_PROVIDER_ID = 'spotify';
/** Shown when a placeholder is played. */
export const UNMATCHED_TRACK_MESSAGE =
  'Not matched yet. Review this Spotify track in Import to pick a version to play.';

/**
 * Picks one Spotify export file (.csv or .json; no zip) as text. Optional:
 * the app provides it over `pickTextFile` (@open-record/providers/local).
 */
export abstract class ImportFilePort {
  /** Resolves null when the picker is dismissed. */
  abstract pickTextFile(): Promise<{ name: string; text: string } | null>;
}

export type ImportStatus = 'idle' | 'running' | 'paused' | 'done';
export type ImportItemState = 'pending' | 'matched' | 'review' | 'unmatched';

export interface ImportCandidate {
  /** A remote (`remote:`) search result. */
  track: Track;
  /** 0..1. */
  score: number;
  durationMatch: boolean;
}

/**
 * One imported track and its match state. Reduced fields only (no raw
 * payloads). Two kinds share the job, review and progress:
 *
 * - Spotify (no `origin`): a placeholder matched to a YouTube result.
 *   Review suggestions are `candidates` (tracks); fixes are
 *   `acceptCandidate`, `skip`, `research` and `useLink`.
 * - YouTube (`origin: 'youtube'`): the song link is the fixed audio source;
 *   only its song details are looked up. Review suggestions are
 *   `metaCandidates` (metadata); fixes are `acceptMetadata`, `keepOriginal`,
 *   `skip`, `research`, and `useLink` (when `linkError` says the link failed).
 */
export interface ImportItem {
  /** Placeholder track id (`spotify:...`), or the song's track id for YouTube items; stable for the job. */
  key: string;
  title: string;
  artists: string[];
  artist: string;
  album?: string;
  durationMs?: number;
  isrc?: string;
  spotifyId?: string;
  state: ImportItemState;
  /** Best search results first (Spotify review and unmatched items). */
  candidates?: ImportCandidate[];
  /** Song-detail suggestions, best first (YouTube review and unmatched items). */
  metaCandidates?: MetadataCandidate[];
  /** YouTube items: why the song's link cannot be used (state `unmatched`; fix with `useLink`). */
  linkError?: string;
  /** Id of the remote track that replaced the placeholder (matched items; YouTube items after `useLink`). */
  matchId?: string;
  score?: number;
  /** Accepted or skipped by the user. */
  manual?: boolean;
  /** Failed search attempts (unexpected errors). */
  attempts?: number;
  /** Imported as a Liked Song (or "Also add to Liked Songs" was ticked): bookmarked in the library. */
  liked?: true;
  /**
   * A YouTube song: its key is the track id. `pending` until its song details
   * are looked up (jobs from older versions stored them as `matched`).
   */
  origin?: 'youtube';
}

export interface ImportProgress {
  total: number;
  matched: number;
  review: number;
  unmatched: number;
  pending: number;
}

export interface ImportOptions {
  /** "Also add these songs to Liked Songs": every playlist track is bookmarked too. */
  likeAll?: boolean;
  /** Names the import session, e.g. the export file name. */
  label?: string;
}

export interface ImportYoutubeOptions {
  /** "Also add to Liked Songs": the song, or every playlist song, is bookmarked in the library. */
  likeToo?: boolean;
}

/** Kind and name of the latest import into the job (progress panel label). */
export interface ImportJobSource {
  kind: 'spotify' | 'youtube';
  /** Spotify: the export file name; YouTube: the playlist or song title. */
  label?: string;
}

/** What `ImportStore.startYoutube` added. */
export interface ImportYoutubeSummary {
  /** Playlist name as created (the YouTube playlist title), or the song title for a single song. */
  title: string;
  /** The new playlist; absent for a single song (added to the library only). */
  playlistId?: string;
  /** A single song link was added to the library (no playlist). */
  single: boolean;
  /** Songs new to the library. */
  added: number;
  /** Songs already in the library (kept as they were). */
  existing: number;
  /** Private or deleted videos left out. */
  unavailable: number;
  /** The playlist had more songs than the server returns. */
  truncated: boolean;
}

type YoutubeList = Awaited<ReturnType<NonNullable<RemoteServerPort['importPlaylist']>>>;

export interface ImportSummary {
  playlists: number;
  liked: number;
  /** Tracks new to the job (repeats across files count once). */
  tracks: number;
  /** New tracks matched from earlier imports without a search. */
  alreadyMatched: number;
}

/** Persisted job (settings key `spotifyImport`). */
interface ImportJob {
  version: 1;
  status: Exclude<ImportStatus, 'idle'>;
  items: ImportItem[];
  /** Matched remote track by `isrc:` / `sp:` key, reused by later imports. */
  cache: Record<string, Track>;
  error?: string;
  /**
   * Set once tracks of imported "liked" playlists were bookmarked (jobs from
   * before `liked.csv` was read as Liked Songs). Absent = not checked yet.
   */
  likedPlaylistsSaved?: true;
  /** Set once every `liked` item was checked to be bookmarked (later imports bookmark directly). */
  likedSaved?: true;
  /** The latest import (label only). */
  source?: ImportJobSource;
  /**
   * `repairSignature()` when `repairMatched()` last finished. Startup skips
   * the repair while it still matches (nothing it could fix has changed).
   */
  repairedSignature?: string;
}

/** Pause between searches; the server allows 30 searches a minute. */
const PACE_MS = 2_100;
/** Pause after a song-detail lookup batch (one rate-limited request). */
const ENRICH_PACE_MS = 3_000;
/** Wait after a 429 (no Retry-After hint). */
const RATE_LIMIT_WAIT_MS = 60_000;
const BUSY_WAIT_SEC = 10;
const MAX_ATTEMPTS = 3;
const MAX_CANDIDATES = 5;
const PERSIST_DEBOUNCE_MS = 500;
/** Best title similarity below which catalogue aliases are fetched. */
const LOW_TITLE_SCORE = 0.6;
const NO_ALIASES: MatchAliases = { titles: [], artists: [] };
/** Errors that stop the queue until the user resumes (server down, token, config). */
const PAUSING_ERRORS = new Set(['AuthError', 'NetworkError', 'RemoteConfigError']);
const NO_SERVER = 'Set up a download server in Settings to match imported tracks.';
const NO_YOUTUBE_SERVER = 'Set up a download server in Settings to import YouTube playlists.';
const NOT_YOUTUBE_SUPPORTED = 'This download server cannot import playlists. Update it, then try again.';
const UNKNOWN_ARTIST = 'Unknown artist';
const INVALID_LINK = 'Paste a full http:// or https:// link.';
const LINK_UNAVAILABLE = 'This song link is unavailable. Paste another link.';
const NOT_A_YOUTUBE_ITEM = 'Song details can only be chosen for YouTube imports.';

/**
 * Spotify import: turns parsed exports into playlists and library entries
 * right away (metadata-only placeholders, nothing is downloaded), then
 * matches each track to a YouTube Music result in a resumable background
 * queue (one search at a time, paced for the server's rate limit). Matched
 * placeholders are replaced everywhere by the remote track; uncertain ones
 * wait for review. Progress, matches and manual fixes are persisted.
 */
@Injectable({ providedIn: 'root' })
export class ImportStore {
  private readonly storage = inject(StoragePort);
  private readonly library = inject(LibraryStore);
  private readonly playlists = inject(PlaylistsStore);
  private readonly sessions = inject(ImportSessionsStore);
  private readonly remote = inject(RemoteServerPort, { optional: true });
  private readonly files = inject(ImportFilePort, { optional: true });
  /** Song-detail lookup for YouTube items (run by this queue). */
  private readonly enrich = inject(MetadataEnrichStore);

  private readonly _job = signal<ImportJob | null>(null);
  private readonly _retryAt = signal<number | null>(null);
  private readonly _searching = signal<ReadonlySet<string>>(new Set());
  private readonly _importing = signal(false);

  /** `idle` = no job. */
  readonly status = computed<ImportStatus>(() => this._job()?.status ?? 'idle');
  /** A YouTube playlist or song link is being fetched. */
  readonly importing = this._importing.asReadonly();
  /**
   * @deprecated The song-detail lookup is part of the job now (`status`,
   * `progress`, `error`, `retryAt`). Always `idle`; remove from the UI.
   */
  readonly enrichStatus = signal<'idle' | 'running' | 'paused' | 'done'>('idle').asReadonly();
  /** @deprecated See `enrichStatus`. Always zero. */
  readonly enrichProgress = signal({ total: 0, enriched: 0, unmatched: 0, pending: 0 }).asReadonly();
  /** @deprecated See `enrichStatus`. Always null. */
  readonly enrichError = signal<string | null>(null).asReadonly();
  /** @deprecated See `enrichStatus`. Always null. */
  readonly enrichRetryAt = signal<number | null>(null).asReadonly();
  /** Kind and name of the latest import (for the progress label), or null. */
  readonly source = computed<ImportJobSource | null>(() => this._job()?.source ?? null);
  /** Why the queue paused (user-facing), or null. */
  readonly error = computed(() => this._job()?.error ?? null);
  /** Epoch ms the queue resumes after a busy / rate-limit wait, or null. */
  readonly retryAt = this._retryAt.asReadonly();
  readonly hasJob = computed(() => this._job() !== null);
  readonly items = computed<readonly ImportItem[]>(() => this._job()?.items ?? []);
  readonly progress = computed<ImportProgress>(() => {
    const p: ImportProgress = { total: 0, matched: 0, review: 0, unmatched: 0, pending: 0 };
    for (const item of this.items()) {
      p.total++;
      p[item.state]++;
    }
    return p;
  });
  /** Match state by item key (live session counts). */
  readonly itemStates = computed<ReadonlyMap<string, ImportItemState>>(
    () => new Map(this.items().map((i) => [i.key, i.state])),
  );
  /** Matching still needs the user: running, paused, or items pending or in review. */
  readonly needsAttention = computed(() => {
    const s = this.status();
    if (s === 'running' || s === 'paused') return true;
    const p = this.progress();
    return p.pending > 0 || p.review > 0;
  });
  /** Items waiting for the user to pick a candidate (or skip). */
  readonly reviewItems = computed(() => this.items().filter((i) => i.state === 'review'));
  readonly unmatchedItems = computed(() => this.items().filter((i) => i.state === 'unmatched'));
  /** Keys of items being searched again (`research`). */
  readonly searching = this._searching.asReadonly();
  /** A file picker is available (`pickFile`). */
  readonly canPickFile = !!this.files;

  private readonly loaded: Promise<void>;
  private running = false;
  private abort: AbortController | null = null;
  /** Catalogue aliases per item key (this session only). */
  private readonly aliasCache = new Map<string, MatchAliases>();
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  /** Serialises searches (queue and `research`); see `inSearchSlot`. */
  private searchLock: Promise<void> = Promise.resolve();
  private lastSearchEnd = 0;
  /** In-flight `research` calls by item key. */
  private readonly researchAborts = new Map<string, AbortController>();

  constructor() {
    const registry = inject(MusicSourceRegistry);
    if (!registry.get(SPOTIFY_PROVIDER_ID)) {
      // Placeholders render like any track but cannot play.
      registry.register({
        id: SPOTIFY_PROVIDER_ID,
        capabilities: { search: false, download: false },
        search: async () => [],
        resolve: () => Promise.reject(new Error(UNMATCHED_TRACK_MESSAGE)),
      });
    }
    this.loaded = this.hydrate();
  }

  ready(): Promise<void> {
    return this.loaded;
  }

  /** Startup: resume a job left running. */
  async restore(): Promise<void> {
    await this.loaded;
    await this.migrateLegacyLookup().catch(() => undefined);
    if (!(await this.repairedUpToDate().catch(() => false))) {
      await this.saveLikedPlaylists().catch(() => undefined);
      await this.repairMatched().catch(() => undefined);
    }
    if (this._job()?.status === 'running') void this.run();
  }

  /**
   * The one-time liked fixes ran and the last full `repairMatched()` saw the
   * same items, matches, playlists and bookmarks as now: repair is a no-op.
   */
  private async repairedUpToDate(): Promise<boolean> {
    const job = this._job();
    if (!job?.repairedSignature || !job.likedPlaylistsSaved || !job.likedSaved) return false;
    await Promise.all([this.library.ready(), this.playlists.ready()]);
    return job.repairedSignature === this.repairSignature(job);
  }

  /** Cheap fingerprint of everything `repairMatched()` reads. */
  private repairSignature(job: ImportJob): string {
    let matched = 0;
    // FNV-1a over matched ids in item order, so re-matching changes it.
    let hash = 0x811c9dc5;
    for (const item of job.items) {
      if (item.state !== 'matched' || !item.matchId) continue;
      matched++;
      const id = `${item.matchId}\n`;
      for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 0x01000193);
    }
    const playlists = this.playlists.playlists();
    let updatedAt = 0;
    for (const p of playlists) if (p.updatedAt > updatedAt) updatedAt = p.updatedAt;
    return [job.items.length, matched, (hash >>> 0).toString(36), playlists.length, updatedAt, this.library.savedIds().length].join(':');
  }

  /**
   * Songs still queued by the old stand-alone song-detail lookup go back to
   * `pending` so this queue looks them up (and can send them to review).
   */
  private async migrateLegacyLookup(): Promise<void> {
    const ids = new Set(await this.enrich.takeLegacyQueue());
    const job = this._job();
    if (!job || !ids.size) return;
    const requeue = (i: ImportItem) => i.origin === 'youtube' && i.state === 'matched' && !i.manual && !i.matchId && ids.has(i.key);
    if (!job.items.some(requeue)) return;
    this._job.set({
      ...job,
      status: job.status === 'paused' ? 'paused' : 'running',
      items: job.items.map((i) => (requeue(i) ? { ...i, state: 'pending' } : i)),
    });
    await this.persist();
  }

  /**
   * One-time fix for jobs that imported Exportify's `liked.csv` as a playlist
   * named "liked": bookmark that playlist's imported tracks (keeping their
   * added dates) so they show in Library. The playlist itself stays.
   */
  private async saveLikedPlaylists(): Promise<void> {
    const job = this._job();
    if (!job || job.likedPlaylistsSaved) return;
    await Promise.all([this.library.ready(), this.playlists.ready()]);
    const imported = new Set(job.items.flatMap((i) => (i.matchId ? [i.key, i.matchId] : [i.key])));
    const entries: { id: string; savedAt?: number }[] = [];
    for (const p of this.playlists.playlists()) {
      if (!isLikedSongsName(p.name)) continue;
      for (const id of p.trackIds) {
        if (imported.has(id)) entries.push({ id, savedAt: p.addedAt?.[id] });
      }
    }
    await this.library.bookmarkWithoutSaving(entries);
    this.update((j) => ({ ...j, likedPlaylistsSaved: true }));
    await this.persist();
  }

  /**
   * Point bookmarks and playlist entries still on the placeholder of a
   * matched item at its match. Catches ids written while the queue swapped
   * them (importing more during a running job); such bookmarks were hidden
   * from Library. Idempotent; never downloads.
   */
  private async repairMatched(): Promise<void> {
    const job = this._job();
    if (!job) return;
    await Promise.all([this.library.ready(), this.playlists.ready()]);
    const listed = new Set(this.playlists.playlists().flatMap((p) => p.trackIds));
    for (const item of job.items) {
      if (item.state !== 'matched' || !item.matchId) continue;
      if (listed.has(item.key)) await this.playlists.replaceTrackEverywhere(item.key, item.matchId);
      if (this.library.isSaved(item.key)) await this.library.replaceSaved(item.key, item.matchId);
    }
    // A liked item is bookmarked under whatever id it has now.
    if (!job.likedSaved) {
      const liked = job.items.filter((i) => i.liked).map((i) => ({ id: this.currentId(i.key) }));
      await this.library.bookmarkWithoutSaving(liked);
      this.update((j) => ({ ...j, likedSaved: true }));
    }
    // Recorded only after a full pass, so a failed repair runs again next start.
    const current = this._job();
    if (!current) return;
    const signature = this.repairSignature(current);
    if (current.repairedSignature === signature && job.likedSaved) return;
    this.update((j) => ({ ...j, repairedSignature: signature }));
    await this.persist();
  }

  /** Track id an imported item uses now: its match, else the placeholder (or the id itself). */
  resolveId(key: string): string {
    return this.currentId(key);
  }

  /** Track id an item's tracks use now: its match, else the placeholder. */
  private currentId(key: string): string {
    const item = this.item(key);
    return item?.state === 'matched' && item.matchId ? item.matchId : key;
  }

  // ---- Files ---------------------------------------------------------------

  /**
   * Parse one export file: Exportify `.csv` (Liked Songs when so named) or a
   * `.json` from Spotify's data download. Throws an Error with a user-facing
   * message for anything else.
   */
  parseFile(name: string, text: string): ParsedImport {
    return parseImportFile(name, text);
  }

  /** Open the file picker and parse the chosen file; null when dismissed. */
  async pickFile(): Promise<{ name: string; parsed: ParsedImport } | null> {
    if (!this.files) throw new Error('Picking files is not available.');
    const file = await this.files.pickTextFile();
    if (!file) return null;
    return { name: file.name, parsed: this.parseFile(file.name, file.text) };
  }

  // ---- Job -----------------------------------------------------------------

  /**
   * Create the playlists and liked songs now (as unplayable placeholders, or
   * the remote track when an earlier import already matched it), then start
   * matching in the background. Adds to an existing job.
   */
  async start(parsed: ParsedImport, options: ImportOptions = {}): Promise<ImportSummary> {
    await Promise.all([this.loaded, this.library.ready(), this.playlists.ready()]);
    const job: ImportJob = this._job() ?? {
      version: 1,
      status: 'running',
      items: [],
      cache: {},
      // Liked Songs are bookmarked directly from now on.
      likedPlaylistsSaved: true,
      likedSaved: true,
    };
    const byKey = new Map<string, ImportItem>();
    for (const item of job.items) if (!item.origin) for (const k of idKeys(item)) byKey.set(k, item);

    const newItems: ImportItem[] = [];
    let alreadyMatched = 0;
    /** Key of the item each imported track maps to. */
    const keyOf = (t: ImportedTrack): string => {
      const keys = idKeys(t);
      let item = keys.map((k) => byKey.get(k)).find(Boolean);
      if (!item) {
        item = {
          key: placeholderId(t),
          title: t.title,
          artists: t.artists,
          artist: t.artist || 'Unknown artist',
          state: 'pending',
        };
        if (t.album) item.album = t.album;
        if (t.durationMs) item.durationMs = t.durationMs;
        if (t.isrc) item.isrc = t.isrc;
        if (t.spotifyId) item.spotifyId = t.spotifyId;
        const cached = keys.map((k) => job.cache[k]).find(Boolean);
        if (cached) {
          item.state = 'matched';
          item.matchId = cached.id;
          alreadyMatched++;
        }
        newItems.push(item);
      }
      for (const k of keys) byKey.set(k, item);
      return item.key;
    };

    const playlistKeys = parsed.playlists.map((p) => p.tracks.map(keyOf));
    const likedTracks = options.likeAll
      ? [...parsed.liked, ...parsed.playlists.flatMap((p) => p.tracks)]
      : parsed.liked;
    const now = Date.now();
    // One bookmark per item, dated by its first occurrence in the export.
    const liked = new Map<string, number>();
    likedTracks.forEach((t, i) => {
      const key = keyOf(t);
      if (!liked.has(key)) liked.set(key, parseAddedAt(t.addedAt) ?? now - i);
    });

    // Index first so playlists and bookmarks resolve immediately.
    const fresh = newItems.filter((i) => i.state === 'pending').map(placeholderTrack);
    const reused = newItems
      .filter((i) => i.state === 'matched')
      .flatMap((i) => (i.matchId ? [cachedById(job.cache, i.matchId)] : []))
      .filter((t): t is Track => !!t);
    await this.library.addMetadataTracks([...fresh, ...reused]);

    const next: ImportJob = {
      ...job,
      status: newItems.some((i) => i.state === 'pending') || job.status === 'running' ? 'running' : job.status,
      items: [...job.items, ...newItems].map((i) => (liked.has(i.key) && !i.liked ? { ...i, liked: true } : i)),
      source: options.label ? { kind: 'spotify', label: options.label } : { kind: 'spotify' },
    };
    delete next.error;
    this._job.set(next);
    await this.persist();

    // Recorded once the items exist, so a later failure cannot drop the session.
    const referenced = [...new Set([...playlistKeys.flat(), ...liked.keys()])];
    const added = new Set(newItems.map((i) => i.key));
    await this.sessions
      .record({
        kind: 'spotify',
        label: options.label,
        added: added.size,
        skipped: referenced.filter((k) => !added.has(k)).length,
        failed: 0,
        trackIds: referenced,
      })
      .catch(() => undefined);

    // Ids are resolved late: a running queue may have matched an item meanwhile.
    for (const [i, p] of parsed.playlists.entries()) {
      const name = p.name.trim().slice(0, PLAYLIST_NAME_MAX) || 'Imported playlist';
      await this.playlists.createWithTracks(
        name,
        playlistKeys[i].map((k) => this.currentId(k)),
        p.tracks.map((t) => parseAddedAt(t.addedAt)),
      );
    }
    await this.library.bookmarkWithoutSaving([...liked].map(([key, savedAt]) => ({ id: this.currentId(key), savedAt })));
    // Anything swapped while those were written follows its match.
    await this.repairMatched();

    if (this._job()?.status === 'running') void this.run();
    return {
      playlists: parsed.playlists.length,
      liked: liked.size,
      tracks: newItems.length,
      alreadyMatched,
    };
  }

  /**
   * Import a public YouTube / YT Music playlist link (a new playlist) or a
   * single song link (library only). Its new songs join the job as `pending`
   * items: the queue looks up their song details, applies confident ones and
   * sends the rest to review with metadata suggestions. With
   * `options.likeToo` the song (or every playlist song) is bookmarked in the
   * library. Throws an Error with a user-facing message.
   */
  async startYoutube(
    url: string,
    signal?: AbortSignal,
    options: ImportYoutubeOptions = {},
  ): Promise<ImportYoutubeSummary> {
    const remote = this.remote;
    if (!remote?.configured) throw new Error(NO_YOUTUBE_SERVER);
    if (!remote.importPlaylist) throw new Error(NOT_YOUTUBE_SUPPORTED);
    this._importing.set(true);
    try {
      await Promise.all([this.loaded, this.library.ready(), this.playlists.ready()]);
      let list: YoutubeList;
      try {
        list = await remote.importPlaylist(url.trim(), signal);
      } catch (error) {
        if (isAbort(error)) throw error;
        throw new Error(youtubeErrorMessage(error));
      }
      const tracks = dedupeById(list.tracks);
      if (!tracks.length) {
        throw new Error(
          list.single
            ? 'This song is private, deleted or unavailable.'
            : list.unavailable
              ? 'Every video in this playlist is private or deleted.'
              : 'This playlist is empty.',
        );
      }
      const known = this.library.trackMap();
      const fresh = tracks.filter((t) => !known.has(t.id));
      await this.library.addMetadataTracks(fresh);

      const ids = tracks.map((t) => t.id);
      let title: string;
      let playlistId: string | undefined;
      if (list.single) {
        title = (tracks[0].title.trim() || 'YouTube song').slice(0, PLAYLIST_NAME_MAX);
      } else {
        title = list.title.trim().slice(0, PLAYLIST_NAME_MAX) || 'YouTube playlist';
        const base = Date.now();
        // Playlist order is kept: earlier entries get earlier added dates.
        const playlist = await this.playlists.createWithTracks(
          title,
          ids,
          ids.map((_, i) => base - (ids.length - i)),
        );
        playlistId = playlist.id;
      }

      this.addYoutubeItems(tracks, new Set(fresh.map((t) => t.id)), { kind: 'youtube', label: title }, !!options.likeToo);
      await this.persist();
      if (options.likeToo) {
        // First song on top of the library, like a playlist added to Library.
        const base = Date.now();
        await this.library.bookmarkWithoutSaving(ids.map((id, i) => ({ id: this.currentId(id), savedAt: base - i })));
      }
      await this.sessions
        .record({
          kind: 'youtube',
          label: title,
          added: fresh.length,
          skipped: tracks.length - fresh.length + list.unavailable,
          failed: 0,
          trackIds: ids,
        })
        .catch(() => undefined);

      if (this._job()?.status === 'running') void this.run();
      return {
        title,
        playlistId,
        single: !!list.single,
        added: fresh.length,
        existing: tracks.length - fresh.length,
        unavailable: list.unavailable,
        truncated: list.truncated,
      };
    } finally {
      this._importing.set(false);
    }
  }

  /**
   * One job item per YouTube song (keys are track ids). Songs new to the
   * library wait for a song-detail lookup; songs already there are kept as
   * they were (`matched`).
   */
  private addYoutubeItems(
    tracks: readonly Track[],
    fresh: ReadonlySet<string>,
    source: ImportJobSource,
    liked: boolean,
  ): void {
    const job: ImportJob = this._job() ?? {
      version: 1,
      status: 'done',
      items: [],
      cache: {},
      likedPlaylistsSaved: true,
      likedSaved: true,
    };
    const have = new Set(job.items.map((i) => i.key));
    const keys = new Set(tracks.map((t) => t.id));
    const items: ImportItem[] = tracks
      .filter((t) => !have.has(t.id))
      .map((t) => {
        const item: ImportItem = {
          key: t.id,
          title: t.title,
          artists: t.artist && t.artist !== UNKNOWN_ARTIST ? [t.artist] : [],
          artist: t.artist || UNKNOWN_ARTIST,
          state: fresh.has(t.id) ? 'pending' : 'matched',
          origin: 'youtube',
        };
        if (t.album) item.album = t.album;
        if (t.durationSec) item.durationMs = t.durationSec * 1000;
        if (liked) item.liked = true;
        return item;
      });
    const pending = items.some((i) => i.state === 'pending');
    const next: ImportJob = {
      ...job,
      status: pending || job.status === 'running' ? 'running' : job.status,
      items: [
        ...job.items.map((i) => (liked && keys.has(i.key) && !i.liked ? { ...i, liked: true as const } : i)),
        ...items,
      ],
      source,
    };
    delete next.error;
    this._job.set(next);
  }

  /** Stop matching and song-detail lookup after the current step (resume later). */
  async pause(): Promise<void> {
    this.update((job) => (job.status === 'running' ? { ...job, status: 'paused' } : job));
    this.stopRunner();
    await this.persist();
  }

  /** Continue matching and song-detail lookup (also retries after a pausing error). */
  async resume(): Promise<void> {
    await this.resume_();
  }

  /**
   * Stop for good: pending Spotify tracks become unmatched (placeholders
   * stay); pending YouTube songs keep their YouTube details (`matched`).
   */
  async cancel(): Promise<void> {
    this.stopRunner();
    this.update((job) => ({
      ...job,
      status: 'done',
      error: undefined,
      items: job.items.map((i) =>
        i.state !== 'pending' ? i : { ...i, state: i.origin === 'youtube' ? 'matched' : 'unmatched' },
      ),
    }));
    await this.persist();
  }

  /** @deprecated The song-detail lookup is part of the job now; a no-op. */
  async dismissEnrichment(): Promise<void> {
    return;
  }

  /**
   * Use a candidate (by its track id, or any remote Track, e.g. from a manual
   * search) for a review or unmatched item: replaces the placeholder in
   * playlists and the library. Nothing is downloaded. For a YouTube item a
   * string id may also name one of its `metaCandidates` (same as
   * `acceptMetadata`); a Track replaces its link.
   */
  async acceptCandidate(key: string, candidate: string | Track): Promise<void> {
    await this.loaded;
    const item = this.item(key);
    if (!item || item.state === 'matched') return;
    if (item.origin === 'youtube' && typeof candidate === 'string' && item.metaCandidates?.some((c) => c.id === candidate)) {
      return this.acceptMetadata(key, candidate);
    }
    const track =
      typeof candidate === 'string'
        ? item.candidates?.find((c) => c.track.id === candidate)?.track
        : candidate;
    if (!track) throw new Error('That match is no longer available.');
    const score = item.candidates?.find((c) => c.track.id === track.id)?.score;
    await this.applyMatch(item, track, score, true);
    this.finishIfIdle();
    await this.persist();
  }

  /**
   * YouTube review or unmatched item: apply one of its `metaCandidates` (by
   * `MetadataCandidate.id`) to the song in place (same track id; fields the
   * user edited stay) and mark it matched. Throws a user-facing Error when the
   * suggestion is gone or the song's link failed (use `useLink` first).
   */
  async acceptMetadata(key: string, candidateId: string): Promise<void> {
    await this.loaded;
    const item = this.item(key);
    if (!item || item.state === 'matched') return;
    if (item.origin !== 'youtube') throw new Error(NOT_A_YOUTUBE_ITEM);
    if (item.linkError) throw new Error(LINK_UNAVAILABLE);
    const candidate = item.metaCandidates?.find((c) => c.id === candidateId);
    if (!candidate) throw new Error('That suggestion is no longer available.');
    await this.enrich.apply(this.currentId(key), candidate);
    this.patchItem(key, { state: 'matched', score: candidate.score, manual: true, metaCandidates: undefined });
    this.finishIfIdle();
    await this.persist();
  }

  /**
   * YouTube review or unmatched item: keep the song's YouTube details (no
   * change to the track) and mark it matched. Throws a user-facing Error when
   * the song's link failed (use `useLink` instead).
   */
  async keepOriginal(key: string): Promise<void> {
    await this.loaded;
    const item = this.item(key);
    if (!item || item.state === 'matched') return;
    if (item.origin !== 'youtube') throw new Error(NOT_A_YOUTUBE_ITEM);
    if (item.linkError) throw new Error(LINK_UNAVAILABLE);
    this.patchItem(key, { state: 'matched', manual: true, metaCandidates: undefined });
    this.finishIfIdle();
    await this.persist();
  }

  /**
   * A YouTube item's song link cannot be played or downloaded (e.g. the video
   * was removed): it becomes unmatched with `linkError` so the review offers
   * "Paste another link" (`useLink`). No-op for other items.
   */
  async markLinkFailed(key: string, reason = LINK_UNAVAILABLE): Promise<void> {
    await this.loaded;
    const item = this.item(key);
    if (!item || item.origin !== 'youtube' || item.matchId) return;
    this.patchItem(key, { state: 'unmatched', linkError: reason, metaCandidates: undefined, manual: undefined });
    this.finishIfIdle();
    await this.persist();
  }

  /** Leave a review item unmatched (a Spotify placeholder stays; a YouTube song keeps its details). */
  async skip(key: string): Promise<void> {
    await this.loaded;
    const item = this.item(key);
    if (!item || item.state !== 'review') return;
    this.patchItem(key, { state: 'unmatched', manual: true });
    this.finishIfIdle();
    await this.persist();
  }

  /** Send an unmatched item that still has suggestions back to review. */
  async reopen(key: string): Promise<void> {
    await this.loaded;
    const item = this.item(key);
    if (!item || item.state !== 'unmatched' || !(item.candidates?.length || item.metaCandidates?.length)) return;
    this.patchItem(key, { state: 'review', manual: undefined });
    this.finishIfIdle();
    await this.persist();
  }

  /**
   * Search again for one review or unmatched item (fresh results, aliases
   * refetched). A confident match is applied as usual; otherwise the new
   * suggestions replace the old ones and the item waits in review. With no
   * results the old suggestions stay. Paced with the import queue; throws a
   * user-facing Error on failure (the job is not paused). For a YouTube item
   * the song details are looked up again instead (fresh `metaCandidates`).
   */
  async research(key: string): Promise<void> {
    await this.loaded;
    const item = this.item(key);
    if (!item || (item.state !== 'review' && item.state !== 'unmatched') || this.researchAborts.has(key)) return;
    if (!this.remote?.configured) throw new Error(NO_SERVER);
    const abort = new AbortController();
    this.researchAborts.set(key, abort);
    this._searching.update((s) => new Set(s).add(key));
    try {
      await Promise.all([this.library.ready(), this.playlists.ready()]);
      if (item.origin === 'youtube') {
        if (item.linkError) throw new Error(LINK_UNAVAILABLE);
        const track = this.library.track(this.currentId(key));
        if (!track) return;
        const [match] = await this.inSearchSlot(abort.signal, () => this.enrich.lookup([track], abort.signal));
        const current = this.item(key);
        if (abort.signal.aborted || !current || (current.state !== 'review' && current.state !== 'unmatched')) return;
        if (match) await this.applyLookup(current, match, true);
        await this.persist();
        return;
      }
      this.aliasCache.delete(key);
      const result = await this.searchItem(item, abort.signal);
      const current = this.item(key);
      if (!current || (current.state !== 'review' && current.state !== 'unmatched')) return;
      if (result.verdict === 'matched') {
        await this.applyResult(current, result);
        this.finishIfIdle();
      } else if (result.ranked.length) {
        const candidates = result.ranked
          .slice(0, MAX_CANDIDATES)
          .map(({ candidate, score, durationMatch }) => ({ track: candidate, score, durationMatch }));
        this.patchItem(key, { state: 'review', candidates, manual: undefined });
      }
      await this.persist();
    } catch (error) {
      if (isAbort(error) || abort.signal.aborted) return;
      if (error instanceof Error && error.message === LINK_UNAVAILABLE) throw error;
      throw new Error(remoteErrorMessage(error));
    } finally {
      this.endSearching(key, abort);
    }
  }

  private endSearching(key: string, abort: AbortController): void {
    if (this.researchAborts.get(key) === abort) this.researchAborts.delete(key);
    this._searching.update((s) => {
      const next = new Set(s);
      next.delete(key);
      return next;
    });
  }

  /**
   * Match a review or unmatched item to a pasted video link (YouTube or any
   * site the server supports), resolved like a pasted link in Search. For a
   * YouTube item (e.g. one with `linkError`) the new link replaces the song
   * everywhere, keeping its current details. Throws a user-facing Error for a
   * bad link or a server failure.
   */
  async useLink(key: string, url: string): Promise<void> {
    await this.loaded;
    const link = url.trim();
    if (!/^https?:\/\/\S+$/i.test(link)) throw new Error(INVALID_LINK);
    const item = this.item(key);
    if (!item || (item.state !== 'review' && item.state !== 'unmatched') || this.researchAborts.has(key)) return;
    if (!this.remote?.configured) throw new Error(NO_SERVER);
    const abort = new AbortController();
    this.researchAborts.set(key, abort);
    this._searching.update((s) => new Set(s).add(key));
    try {
      await Promise.all([this.library.ready(), this.playlists.ready()]);
      const track = await this.remote.resolveUrl(link, abort.signal);
      const current = this.item(key);
      if (abort.signal.aborted || !current || (current.state !== 'review' && current.state !== 'unmatched')) return;
      await this.applyMatch(current, track, undefined, true);
      this.finishIfIdle();
      await this.persist();
    } catch (error) {
      if (isAbort(error) || abort.signal.aborted) return;
      throw new Error(remoteErrorMessage(error));
    } finally {
      this.endSearching(key, abort);
    }
  }

  /**
   * Replacement candidates for a library track (e.g. one whose download keeps
   * failing), found with the same search and ranking as the import review.
   * Excludes the track itself. Throws a user-facing Error on server failure.
   */
  async suggest(track: Track, signal: AbortSignal): Promise<ImportCandidate[]> {
    if (!this.remote?.configured) throw new Error(NO_SERVER);
    const artists = track.artist
      .split(/\s*(?:,|&|;|\bfeat\.?|\bft\.?)\s*/i)
      .map((a) => a.trim())
      .filter(Boolean);
    const wanted: ImportedTrack = { title: track.title, artist: track.artist, artists: artists.length ? artists : [track.artist] };
    if (track.album) wanted.album = track.album;
    if (track.durationSec) wanted.durationMs = Math.round(track.durationSec * 1000);
    try {
      const result = await this.searchFor(`fix:${track.id}`, wanted, track.isrc, signal);
      return result.ranked
        .filter(({ candidate }) => candidate.id !== track.id)
        .slice(0, MAX_CANDIDATES)
        .map(({ candidate, score, durationMatch }) => ({ track: candidate, score, durationMatch }));
    } catch (error) {
      if (isAbort(error) || signal.aborted) throw error;
      throw new Error(remoteErrorMessage(error));
    }
  }

  /** A matched track's id changed (its link was replaced): repoint the job at `next`. */
  async replaceMatchId(oldId: string, next: Track): Promise<void> {
    await this.loaded;
    const job = this._job();
    if (!job) return;
    const touches =
      job.items.some((i) => i.matchId === oldId) || Object.values(job.cache).some((t) => t.id === oldId);
    if (!touches) return;
    this.update((j) => {
      const cache: Record<string, Track> = {};
      for (const [k, t] of Object.entries(j.cache)) cache[k] = t.id === oldId ? next : t;
      return { ...j, cache, items: j.items.map((i) => (i.matchId === oldId ? { ...i, matchId: next.id } : i)) };
    });
    await this.persist();
  }

  /** Unmatched tracks as an Exportify-style CSV (re-importable). */
  unmatchedCsv(): string {
    return toCsv([
      ['Track URI', 'Track Name', 'Artist Name(s)', 'Album Name', 'Duration (ms)', 'ISRC'],
      ...this.unmatchedItems().filter((i) => !i.origin).map((i) => [
        i.spotifyId ? `spotify:track:${i.spotifyId}` : '',
        i.title,
        i.artists.join(';'),
        i.album,
        i.durationMs,
        i.isrc,
      ]),
    ]);
  }

  /**
   * Delete all Spotify import data: the job (items, candidates, match cache).
   * Unless `keepPlaceholders`, unmatched placeholders are also removed from
   * playlists, saved records and the library. Matched tracks and YouTube
   * songs stay as normal library tracks.
   */
  async deleteImportData(options: { keepPlaceholders?: boolean } = {}): Promise<void> {
    await this.loaded;
    this.stopRunner();
    for (const abort of this.researchAborts.values()) abort.abort();
    this.researchAborts.clear();
    const placeholders = (this._job()?.items ?? []).filter((i) => i.state !== 'matched' && !i.origin).map((i) => i.key);
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = null;
    this._job.set(null);
    await this.storage.settings.delete(SETTINGS_KEYS.spotifyImport);
    await this.sessions.deleteKind('spotify').catch(() => undefined);
    await this.enrich.takeLegacyQueue();
    if (options.keepPlaceholders || !placeholders.length) return;
    await this.playlists.removeTracksEverywhere(placeholders);
    for (const id of placeholders) {
      if (this.library.isSaved(id)) await this.library.setSaved(id, false);
    }
    await this.library.removeMetadataTracks(placeholders);
  }

  // ---- Queue ---------------------------------------------------------------

  private async resume_(): Promise<void> {
    await this.loaded;
    const job = this._job();
    if (!job) return;
    const pending = job.items.some((i) => i.state === 'pending');
    this._job.set({ ...job, status: pending ? 'running' : 'done', error: undefined });
    await this.persist();
    if (pending) void this.run();
  }

  private async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const abort = (this.abort = new AbortController());
    try {
      await Promise.all([this.library.ready(), this.playlists.ready()]);
      while (!abort.signal.aborted && this._job()?.status === 'running') {
        const item = this._job()?.items.find((i) => i.state === 'pending');
        if (!item) {
          this.update((job) => ({ ...job, status: 'done' }));
          break;
        }
        if (item.origin === 'youtube') {
          if (!(await this.runYoutubeBatch(abort.signal))) break;
          continue;
        }
        const cached = idKeys(item)
          .map((k) => this._job()?.cache[k])
          .find(Boolean);
        if (cached) {
          await this.applyMatch(item, cached, item.score, false);
          continue;
        }
        if (!this.remote?.configured) {
          this.pauseWith(NO_SERVER);
          break;
        }
        try {
          const result = await this.searchItem(item, abort.signal);
          if (abort.signal.aborted) break;
          await this.applyResult(item, result);
          this.schedulePersist();
          await sleep(PACE_MS, abort.signal);
        } catch (error) {
          if (isAbort(error) || abort.signal.aborted) break;
          const name = error instanceof Error ? error.name : '';
          const status = (error as { status?: unknown } | null)?.status;
          if (name === 'busy') {
            const sec = Number((error as { retryAfterSec?: unknown }).retryAfterSec);
            await this.wait((Number.isFinite(sec) && sec > 0 ? sec : BUSY_WAIT_SEC) * 1000, abort.signal);
          } else if (name === 'HttpError' && status === 429) {
            await this.wait(RATE_LIMIT_WAIT_MS, abort.signal);
          } else if (PAUSING_ERRORS.has(name)) {
            this.pauseWith(remoteErrorMessage(error));
            break;
          } else {
            const attempts = (item.attempts ?? 0) + 1;
            this.patchItem(item.key, attempts >= MAX_ATTEMPTS ? { state: 'unmatched', attempts } : { attempts });
            await sleep(PACE_MS, abort.signal).catch(() => undefined);
          }
        }
      }
    } catch (error) {
      if (!isAbort(error)) this.pauseWith(remoteErrorMessage(error));
    } finally {
      this._retryAt.set(null);
      if (this.abort === abort) this.abort = null;
      this.running = false;
      await this.persist().catch(() => undefined);
      // Resumed while this run was winding down after a pause.
      if (abort.signal.aborted && this._job()?.status === 'running') void this.run();
    }
  }

  /**
   * Look up song details for the next pending YouTube items (one batched
   * request, paced with searches). Resolves false when the run must stop
   * (aborted or paused).
   */
  private async runYoutubeBatch(signal: AbortSignal): Promise<boolean> {
    const batch = (this._job()?.items ?? [])
      .filter((i) => i.state === 'pending' && i.origin === 'youtube')
      .slice(0, MAX_ENRICH_BATCH);
    const live: { item: ImportItem; track: Track }[] = [];
    for (const item of batch) {
      const track = this.library.track(this.currentId(item.key));
      if (!track) {
        // Removed from the library meanwhile: nothing to look up.
        this.patchItem(item.key, { state: 'matched' });
      } else if (!hasLink(track)) {
        this.patchItem(item.key, { state: 'unmatched', linkError: LINK_UNAVAILABLE });
      } else {
        live.push({ item, track });
      }
    }
    if (!live.length) {
      this.schedulePersist();
      return true;
    }
    if (!this.remote?.configured) {
      this.pauseWith(NO_SERVER);
      return false;
    }
    if (!this.enrich.available) {
      // Older server without song-detail lookup: keep the YouTube details.
      for (const { item } of live) this.patchItem(item.key, { state: 'matched' });
      this.schedulePersist();
      return true;
    }
    try {
      const matches = await this.inSearchSlot(signal, () =>
        this.enrich.lookup(
          live.map((l) => l.track),
          signal,
        ),
      );
      if (signal.aborted) return false;
      for (const [i, { item }] of live.entries()) {
        const current = this.item(item.key);
        if (current?.state !== 'pending') continue;
        const match = matches[i];
        if (match) await this.applyLookup(current, match, false);
        else this.patchItem(item.key, { state: 'matched' });
      }
      this.schedulePersist();
      await sleep(ENRICH_PACE_MS, signal);
      return true;
    } catch (error) {
      if (isAbort(error) || signal.aborted) return false;
      const name = error instanceof Error ? error.name : '';
      const status = (error as { status?: unknown } | null)?.status;
      if (name === 'busy') {
        await this.wait((busyRetryAfterSec(error) ?? BUSY_WAIT_SEC) * 1000, signal);
      } else if (name === 'HttpError' && status === 429) {
        await this.wait(RATE_LIMIT_WAIT_MS, signal);
      } else if (PAUSING_ERRORS.has(name)) {
        this.pauseWith(remoteErrorMessage(error));
        return false;
      } else {
        // A lookup that keeps failing gives up: the songs keep their YouTube details.
        for (const { item } of live) {
          const attempts = (item.attempts ?? 0) + 1;
          this.patchItem(item.key, attempts >= MAX_ATTEMPTS ? { state: 'matched', attempts } : { attempts });
        }
        await sleep(ENRICH_PACE_MS, signal).catch(() => undefined);
      }
      return !signal.aborted;
    }
  }

  /**
   * Apply a song-detail lookup to a YouTube item: a confident match is
   * applied in place and the item matched; a weaker one waits in review as a
   * metadata suggestion. `research`: a user-started lookup outside the queue.
   */
  private async applyLookup(item: ImportItem, match: EnrichMatch, research: boolean): Promise<void> {
    if (match.confidence >= ENRICH_AUTO_ACCEPT) {
      await this.enrich.apply(this.currentId(item.key), match);
      this.patchItem(item.key, { state: 'matched', score: match.confidence, metaCandidates: undefined, manual: undefined });
      if (research) this.finishIfIdle();
      return;
    }
    this.patchItem(item.key, {
      state: 'review',
      score: match.confidence,
      metaCandidates: toMetadataCandidates(match),
      manual: undefined,
    });
  }

  /**
   * One item's search pipeline: YT Music songs, then plain YouTube, then
   * catalogue aliases (and an alias search) when the title looks off. Runs in
   * the shared search slot so searches stay paced. Errors (aborts, busy,
   * 429, pausing) propagate.
   */
  private searchItem(item: ImportItem, signal: AbortSignal): Promise<MatchResult<Track>> {
    return this.searchFor(item.key, toImported(item), item.isrc, signal);
  }

  /**
   * Ranked YouTube candidates for `wanted` (YT Music, then YouTube, then
   * catalogue aliases), paced with the import queue. `aliasKey` caches aliases.
   */
  private async searchFor(
    aliasKey: string,
    wanted: ImportedTrack,
    isrc: string | undefined,
    signal: AbortSignal,
  ): Promise<MatchResult<Track>> {
    return this.inSearchSlot(signal, async () => {
      const remote = this.remote;
      if (!remote?.configured) throw new Error(NO_SERVER);
      const query = matchQuery(wanted);
      let candidates = await remote.searchSite(query, 'ytmusic', signal);
      let result = matchTrack(wanted, candidates);
      if (result.verdict !== 'matched') {
        // Not in YT Music songs (or unsure): also try plain YouTube uploads.
        await sleep(PACE_MS, signal);
        const extra = await this.fallbackSearch(query, signal);
        const merged = mergeTracks(candidates, extra);
        if (merged.length > candidates.length) result = matchTrack(wanted, (candidates = merged));
      }
      if (result.verdict !== 'matched' && needsAliases(wanted, result)) {
        // Likely the same song titled in another script/language: ask the catalogue.
        const aliases = await this.trackAliases(aliasKey, wanted, isrc, signal);
        if (aliases.titles.length || aliases.artists.length) {
          result = matchTrack(wanted, candidates, aliases);
          const altQuery = result.verdict === 'matched' ? null : aliasQuery(wanted, aliases);
          if (altQuery && fold(altQuery) !== fold(query)) {
            await sleep(PACE_MS, signal);
            const extra = await this.fallbackSearch(altQuery, signal);
            const merged = mergeTracks(candidates, extra);
            if (merged.length > candidates.length) result = matchTrack(wanted, (candidates = merged), aliases);
          }
        }
      }
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      return result;
    });
  }

  /**
   * Runs `task` once no other search is in flight and at least PACE_MS after
   * the last one ended, so the queue and per-item searches share one pace.
   */
  private async inSearchSlot<T>(signal: AbortSignal, task: () => Promise<T>): Promise<T> {
    const previous = this.searchLock;
    let release!: () => void;
    this.searchLock = new Promise<void>((r) => (release = r));
    try {
      await previous;
      const wait = this.lastSearchEnd + PACE_MS - Date.now();
      if (wait > 0) await sleep(wait, signal);
      else if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      try {
        return await task();
      } finally {
        this.lastSearchEnd = Date.now();
      }
    } finally {
      release();
    }
  }

  /**
   * YouTube search used when YT Music found no confident match. Aborts and
   * queue-level errors (busy, 429, pausing) propagate to the run loop; any
   * other failure yields no extra candidates so the YT Music result stands.
   */
  private async fallbackSearch(query: string, signal: AbortSignal): Promise<Track[]> {
    try {
      return (await this.remote?.searchSite(query, 'youtube', signal)) ?? [];
    } catch (error) {
      if (isAbort(error) || signal.aborted) throw error;
      const name = error instanceof Error ? error.name : '';
      const status = (error as { status?: unknown } | null)?.status;
      if (name === 'busy' || (name === 'HttpError' && status === 429) || PAUSING_ERRORS.has(name)) throw error;
      return [];
    }
  }

  /**
   * Catalogue aliases for an item, fetched once per item key (paced like a
   * search). Aborts propagate; any other failure gives no aliases.
   */
  private async trackAliases(
    key: string,
    wanted: ImportedTrack,
    isrc: string | undefined,
    signal: AbortSignal,
  ): Promise<MatchAliases> {
    const cached = this.aliasCache.get(key);
    if (cached) return cached;
    if (!this.remote?.aliases) return NO_ALIASES;
    await sleep(PACE_MS, signal);
    let aliases = NO_ALIASES;
    try {
      const query: { artist: string; title: string; isrc?: string } = {
        artist: wanted.artists[0] ?? wanted.artist,
        title: wanted.title,
      };
      if (isrc) query.isrc = isrc;
      const raw = await this.remote.aliases(query, signal);
      aliases = { titles: raw?.titles ?? [], artists: raw?.artists ?? [] };
    } catch (error) {
      if (isAbort(error) || signal.aborted) throw error;
    }
    if (!signal.aborted) this.aliasCache.set(key, aliases);
    return aliases;
  }

  private async applyResult(item: ImportItem, result: MatchResult<Track>): Promise<void> {
    const candidates = result.ranked
      .slice(0, MAX_CANDIDATES)
      .map(({ candidate, score, durationMatch }) => ({ track: candidate, score, durationMatch }));
    if (result.verdict === 'matched') {
      await this.applyMatch(item, candidates[0].track, candidates[0].score, false);
    } else {
      this.patchItem(item.key, { state: result.verdict, candidates });
    }
  }

  /**
   * Replace the placeholder by `candidate` everywhere and remember the match.
   * A YouTube item's song is replaced the same way, keeping its current details.
   */
  private async applyMatch(item: ImportItem, candidate: Track, score: number | undefined, manual: boolean): Promise<void> {
    if (item.origin === 'youtube') return this.replaceYoutubeLink(item, candidate, score, manual);
    const matched: Track = { ...candidate, title: item.title, artist: item.artist };
    if (item.album) matched.album = item.album;
    if (item.isrc) matched.isrc = item.isrc;
    if (item.spotifyId) matched.external = { ...candidate.external, spotifyId: item.spotifyId };
    // Persist the match before swapping ids so nothing points at an unknown track.
    await this.library.addMetadataTracks([matched]);
    await this.playlists.replaceTrackEverywhere(item.key, matched.id);
    await this.library.replaceSaved(item.key, matched.id);
    await this.library.removeMetadataTracks([item.key]);
    const patch: Partial<ImportItem> = { state: 'matched', matchId: matched.id, candidates: undefined };
    if (score !== undefined) patch.score = score;
    if (manual) patch.manual = true;
    this.patchItem(item.key, patch);
    this.update((job) => {
      const cache = { ...job.cache };
      for (const k of idKeys(item)) if (!k.startsWith('meta:')) cache[k] = matched;
      return { ...job, cache };
    });
  }

  /** A YouTube item's song now plays from `candidate` (a pasted or picked link). */
  private async replaceYoutubeLink(
    item: ImportItem,
    candidate: Track,
    score: number | undefined,
    manual: boolean,
  ): Promise<void> {
    const oldId = this.currentId(item.key);
    const current = this.library.track(oldId);
    const matched: Track = { ...candidate };
    if (current) {
      matched.title = current.title;
      matched.artist = current.artist;
      for (const k of ['album', 'year', 'genre', 'artUrl', 'userEdited'] as const) {
        if (current[k] !== undefined) (matched as unknown as Record<string, unknown>)[k] = current[k];
      }
    }
    await this.library.addMetadataTracks([matched]);
    if (matched.id !== oldId) {
      await this.playlists.replaceTrackEverywhere(oldId, matched.id);
      await this.library.replaceSaved(oldId, matched.id);
      await this.library.removeMetadataTracks([oldId]);
    }
    const patch: Partial<ImportItem> = {
      state: 'matched',
      matchId: matched.id === item.key ? undefined : matched.id,
      candidates: undefined,
      metaCandidates: undefined,
      linkError: undefined,
    };
    if (score !== undefined) patch.score = score;
    if (manual) patch.manual = true;
    this.patchItem(item.key, patch);
  }

  private async wait(ms: number, signal: AbortSignal): Promise<void> {
    this._retryAt.set(Date.now() + ms);
    try {
      await sleep(ms, signal);
    } finally {
      this._retryAt.set(null);
    }
  }

  private pauseWith(error: string): void {
    this.update((job) => ({ ...job, status: 'paused', error }));
  }

  private stopRunner(): void {
    this.abort?.abort();
    this.abort = null;
  }

  /** A finished queue with nothing left to review is done. */
  private finishIfIdle(): void {
    this.update((job) =>
      job.status !== 'running' && !job.items.some((i) => i.state === 'pending')
        ? { ...job, status: 'done' }
        : job,
    );
  }

  // ---- State ---------------------------------------------------------------

  private item(key: string): ImportItem | undefined {
    return this._job()?.items.find((i) => i.key === key);
  }

  private patchItem(key: string, patch: Partial<ImportItem>): void {
    this.update((job) => ({
      ...job,
      items: job.items.map((i) => {
        if (i.key !== key) return i;
        const next: Partial<ImportItem> = { ...i, ...patch };
        for (const k of Object.keys(next) as (keyof ImportItem)[]) if (next[k] === undefined) delete next[k];
        return next as ImportItem;
      }),
    }));
  }

  private update(change: (job: ImportJob) => ImportJob): void {
    const job = this._job();
    if (!job) return;
    const next = change(job);
    if (next === job) return;
    if (next.error === undefined) delete next.error;
    this._job.set(next);
  }

  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persist().catch(() => undefined);
    }, PERSIST_DEBOUNCE_MS);
  }

  private async persist(): Promise<void> {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = null;
    const job = this._job();
    if (!job) return;
    // Suggestions only matter while the user can still pick one (review, or
    // unmatched for `reopen` / `acceptCandidate`): leave them out otherwise.
    const items = job.items.map((item) => {
      if (item.state === 'review' || item.state === 'unmatched') return item;
      if (!item.candidates && !item.metaCandidates) return item;
      const rest = { ...item };
      delete rest.candidates;
      delete rest.metaCandidates;
      return rest;
    });
    await this.storage.settings.set(SETTINGS_KEYS.spotifyImport, { ...job, items } as unknown as JsonValue);
  }

  private async hydrate(): Promise<void> {
    try {
      const raw = await this.storage.settings.get<JsonValue>(SETTINGS_KEYS.spotifyImport);
      const job = raw as unknown as ImportJob | undefined;
      if (job && job.version === 1 && Array.isArray(job.items)) {
        this._job.set({ ...job, cache: job.cache ?? {} });
      }
    } catch {
      // No job: importing starts fresh.
    }
  }
}

/** Identity keys of a track or item: ISRC and Spotify id, else normalised title + artist. */
function idKeys(t: Pick<ImportedTrack, 'isrc' | 'spotifyId' | 'title' | 'artists' | 'artist'>): string[] {
  const keys: string[] = [];
  if (t.isrc) keys.push(`isrc:${t.isrc}`);
  if (t.spotifyId) keys.push(`sp:${t.spotifyId}`);
  if (!keys.length) keys.push(trackKey(t as ImportedTrack));
  return keys;
}

function placeholderId(t: ImportedTrack): string {
  if (t.spotifyId) return `${SPOTIFY_PROVIDER_ID}:${t.spotifyId}`;
  if (t.isrc) return `${SPOTIFY_PROVIDER_ID}:isrc:${t.isrc}`;
  return `${SPOTIFY_PROVIDER_ID}:meta:${hash(trackKey(t))}`;
}

function placeholderTrack(item: ImportItem): Track {
  const track: Track = {
    id: item.key,
    providerId: SPOTIFY_PROVIDER_ID,
    title: item.title,
    artist: item.artist,
  };
  if (item.album) track.album = item.album;
  if (item.durationMs) track.durationSec = Math.round(item.durationMs / 1000);
  if (item.isrc) track.isrc = item.isrc;
  if (item.spotifyId) track.external = { spotifyId: item.spotifyId };
  return track;
}

/** Appends `extra` tracks not already in `base` (by track id). */
function mergeTracks(base: readonly Track[], extra: readonly Track[]): Track[] {
  const seen = new Set(base.map((t) => t.id));
  return [...base, ...extra.filter((t) => !seen.has(t.id) && seen.add(t.id))];
}

const LATIN_ONLY = /^[\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]*$/u;

/** Text in another script, or no candidate with a close title: aliases may help. */
function needsAliases(wanted: ImportedTrack, result: MatchResult<Track>): boolean {
  const text = `${wanted.title} ${wanted.artists.join(' ')} ${wanted.artist}`;
  return !LATIN_ONLY.test(text) || (result.ranked[0]?.titleScore ?? 0) < LOW_TITLE_SCORE;
}

/** "Artist Title" from the aliases (preferring Latin forms), or null without a usable alias title. */
function aliasQuery(wanted: ImportedTrack, aliases: MatchAliases): string | null {
  const latin = (s: string) => LATIN_ONLY.test(s) && /\p{L}/u.test(s);
  const wantTitle = fold(wanted.title);
  const titles = aliases.titles.filter((t) => fold(t) && fold(t) !== wantTitle);
  const title = titles.find(latin) ?? titles[0];
  if (!title) return null;
  const artist = aliases.artists.find(latin) ?? aliases.artists[0] ?? wanted.artists[0] ?? wanted.artist;
  return `${artist} ${title}`.trim();
}

function toImported(item: ImportItem): ImportedTrack {
  const t: ImportedTrack = { title: item.title, artists: item.artists, artist: item.artist };
  if (item.album) t.album = item.album;
  if (item.durationMs) t.durationMs = item.durationMs;
  return t;
}

function cachedById(cache: Record<string, Track>, id: string): Track | undefined {
  return Object.values(cache).find((t) => t.id === id);
}

/** FNV-1a, base36: short stable ids for tracks without ISRC or Spotify id. */
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException('Aborted', 'AbortError'));
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Epoch ms of an export's ISO `addedAt`, or undefined when missing/invalid. */
function parseAddedAt(value: string | undefined): number | undefined {
  const at = Date.parse(value ?? '');
  return Number.isFinite(at) && at > 0 ? at : undefined;
}

/** Friendly copy for playlist fetch failures (the server's message for 4xx). */
function youtubeErrorMessage(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  const status = (error as { status?: unknown } | null)?.status;
  const message = error instanceof Error ? error.message.trim() : '';
  if (name === 'HttpError' && typeof status === 'number' && status >= 400 && status < 500 && status !== 429 && message) {
    return message.charAt(0).toUpperCase() + message.slice(1).replace(/\.?$/, '.');
  }
  return remoteErrorMessage(error);
}

/** The song still has an http(s) page link to stream or download from. */
function hasLink(track: Track): boolean {
  const url = track.source?.url;
  if (url !== undefined) return /^https?:\/\/\S+$/i.test(url);
  // Tracks without a recorded source page fall back to their provider id.
  return track.providerId === 'remote';
}

function dedupeById(tracks: readonly Track[]): Track[] {
  const seen = new Set<string>();
  return tracks.filter((t) => !seen.has(t.id) && !!seen.add(t.id));
}
