import { Injectable, computed, inject, signal } from '@angular/core';
import type { Track } from '@open-record/models';
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
import { LibraryStore } from './library.store';
import { PlaylistsStore, PLAYLIST_NAME_MAX } from './playlists.store';
import { RemoteServerPort } from './ports';
import { isAbort, remoteErrorMessage } from './remote-errors';

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

/** One imported Spotify track and its match state. Reduced fields only (no raw payloads). */
export interface ImportItem {
  /** Placeholder track id (`spotify:...`); stable for the job. */
  key: string;
  title: string;
  artists: string[];
  artist: string;
  album?: string;
  durationMs?: number;
  isrc?: string;
  spotifyId?: string;
  state: ImportItemState;
  /** Best search results first (review and unmatched items). */
  candidates?: ImportCandidate[];
  /** Id of the remote track that replaced the placeholder (matched items). */
  matchId?: string;
  score?: number;
  /** Accepted or skipped by the user. */
  manual?: boolean;
  /** Failed search attempts (unexpected errors). */
  attempts?: number;
  /** Imported as a Liked Song (or "Also add to Liked Songs" was ticked): bookmarked in the library. */
  liked?: true;
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
}

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
}

/** Pause between searches; the server allows 30 searches a minute. */
const PACE_MS = 2_100;
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
const INVALID_LINK = 'Paste a full http:// or https:// link.';

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
  private readonly remote = inject(RemoteServerPort, { optional: true });
  private readonly files = inject(ImportFilePort, { optional: true });

  private readonly _job = signal<ImportJob | null>(null);
  private readonly _retryAt = signal<number | null>(null);
  private readonly _searching = signal<ReadonlySet<string>>(new Set());

  /** `idle` = no job. */
  readonly status = computed<ImportStatus>(() => this._job()?.status ?? 'idle');
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
    await this.saveLikedPlaylists().catch(() => undefined);
    await this.repairMatched().catch(() => undefined);
    if (this._job()?.status === 'running') void this.run();
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
    if (job.likedSaved) return;
    const liked = job.items.filter((i) => i.liked).map((i) => ({ id: this.currentId(i.key) }));
    await this.library.bookmarkWithoutSaving(liked);
    this.update((j) => ({ ...j, likedSaved: true }));
    await this.persist();
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
    for (const item of job.items) for (const k of idKeys(item)) byKey.set(k, item);

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
    };
    delete next.error;
    this._job.set(next);
    await this.persist();

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

  /** Stop matching after the current search (resume later). */
  async pause(): Promise<void> {
    this.update((job) => (job.status === 'running' ? { ...job, status: 'paused' } : job));
    this.stopRunner();
    await this.persist();
  }

  /** Continue matching (also retries after a pausing error). */
  async resume(): Promise<void> {
    return this.resume_();
  }

  /** Stop matching for good: pending tracks become unmatched (placeholders stay). */
  async cancel(): Promise<void> {
    this.stopRunner();
    this.update((job) => ({
      ...job,
      status: 'done',
      error: undefined,
      items: job.items.map((i) => (i.state === 'pending' ? { ...i, state: 'unmatched' } : i)),
    }));
    await this.persist();
  }

  /**
   * Use a candidate (by its track id, or any remote Track, e.g. from a manual
   * search) for a review or unmatched item: replaces the placeholder in
   * playlists and the library. Nothing is downloaded.
   */
  async acceptCandidate(key: string, candidate: string | Track): Promise<void> {
    await this.loaded;
    const item = this.item(key);
    if (!item || item.state === 'matched') return;
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

  /** Leave a review item unmatched (its placeholder stays). */
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
    if (!item || item.state !== 'unmatched' || !item.candidates?.length) return;
    this.patchItem(key, { state: 'review', manual: undefined });
    this.finishIfIdle();
    await this.persist();
  }

  /**
   * Search again for one review or unmatched item (fresh results, aliases
   * refetched). A confident match is applied as usual; otherwise the new
   * suggestions replace the old ones and the item waits in review. With no
   * results the old suggestions stay. Paced with the import queue; throws a
   * user-facing Error on failure (the job is not paused).
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
   * site the server supports), resolved like a pasted link in Search. Throws
   * a user-facing Error for a bad link or a server failure.
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

  /** Unmatched tracks as an Exportify-style CSV (re-importable). */
  unmatchedCsv(): string {
    return toCsv([
      ['Track URI', 'Track Name', 'Artist Name(s)', 'Album Name', 'Duration (ms)', 'ISRC'],
      ...this.unmatchedItems().map((i) => [
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
   * playlists, saved records and the library. Matched tracks stay as normal
   * library tracks.
   */
  async deleteImportData(options: { keepPlaceholders?: boolean } = {}): Promise<void> {
    await this.loaded;
    this.stopRunner();
    for (const abort of this.researchAborts.values()) abort.abort();
    this.researchAborts.clear();
    const placeholders = (this._job()?.items ?? []).filter((i) => i.state !== 'matched').map((i) => i.key);
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = null;
    this._job.set(null);
    await this.storage.settings.delete(SETTINGS_KEYS.spotifyImport);
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
   * One item's search pipeline: YT Music songs, then plain YouTube, then
   * catalogue aliases (and an alias search) when the title looks off. Runs in
   * the shared search slot so searches stay paced. Errors (aborts, busy,
   * 429, pausing) propagate.
   */
  private async searchItem(item: ImportItem, signal: AbortSignal): Promise<MatchResult<Track>> {
    return this.inSearchSlot(signal, async () => {
      const remote = this.remote;
      if (!remote?.configured) throw new Error(NO_SERVER);
      const wanted = toImported(item);
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
        const aliases = await this.trackAliases(item, wanted, signal);
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
  private async trackAliases(item: ImportItem, wanted: ImportedTrack, signal: AbortSignal): Promise<MatchAliases> {
    const cached = this.aliasCache.get(item.key);
    if (cached) return cached;
    if (!this.remote?.aliases) return NO_ALIASES;
    await sleep(PACE_MS, signal);
    let aliases = NO_ALIASES;
    try {
      const query: { artist: string; title: string; isrc?: string } = {
        artist: wanted.artists[0] ?? wanted.artist,
        title: wanted.title,
      };
      if (item.isrc) query.isrc = item.isrc;
      const raw = await this.remote.aliases(query, signal);
      aliases = { titles: raw?.titles ?? [], artists: raw?.artists ?? [] };
    } catch (error) {
      if (isAbort(error) || signal.aborted) throw error;
    }
    if (!signal.aborted) this.aliasCache.set(item.key, aliases);
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

  /** Replace the placeholder by `candidate` everywhere and remember the match. */
  private async applyMatch(item: ImportItem, candidate: Track, score: number | undefined, manual: boolean): Promise<void> {
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
    if (job) await this.storage.settings.set(SETTINGS_KEYS.spotifyImport, job as unknown as JsonValue);
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
