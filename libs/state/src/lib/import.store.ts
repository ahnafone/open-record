import { Injectable, computed, inject, signal } from '@angular/core';
import type { Track } from '@open-record/models';
import { MusicSourceRegistry } from '@open-record/music-source';
import {
  matchQuery,
  matchTrack,
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
}

export interface ImportProgress {
  total: number;
  matched: number;
  review: number;
  unmatched: number;
  pending: number;
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
}

/** Pause between searches; the server allows 30 searches a minute. */
const PACE_MS = 2_100;
/** Wait after a 429 (no Retry-After hint). */
const RATE_LIMIT_WAIT_MS = 60_000;
const BUSY_WAIT_SEC = 10;
const MAX_ATTEMPTS = 3;
const MAX_CANDIDATES = 5;
const PERSIST_DEBOUNCE_MS = 500;
/** Errors that stop the queue until the user resumes (server down, token, config). */
const PAUSING_ERRORS = new Set(['AuthError', 'NetworkError', 'RemoteConfigError']);
const NO_SERVER = 'Set up a download server in Settings to match imported tracks.';

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
  /** A file picker is available (`pickFile`). */
  readonly canPickFile = !!this.files;

  private readonly loaded: Promise<void>;
  private running = false;
  private abort: AbortController | null = null;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

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
    if (this._job()?.status === 'running') void this.run();
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
  async start(parsed: ParsedImport): Promise<ImportSummary> {
    await Promise.all([this.loaded, this.library.ready(), this.playlists.ready()]);
    const job: ImportJob = this._job() ?? { version: 1, status: 'running', items: [], cache: {} };
    const byKey = new Map<string, ImportItem>();
    for (const item of job.items) for (const k of idKeys(item)) byKey.set(k, item);

    const newItems: ImportItem[] = [];
    let alreadyMatched = 0;
    /** Track id each imported track maps to (placeholder or match). */
    const idOf = (t: ImportedTrack): string => {
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
      return item.state === 'matched' && item.matchId ? item.matchId : item.key;
    };

    const playlistIds = parsed.playlists.map((p) => p.tracks.map(idOf));
    const likedIds = parsed.liked.map(idOf);

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
      items: [...job.items, ...newItems],
    };
    delete next.error;
    this._job.set(next);
    await this.persist();

    for (const [i, p] of parsed.playlists.entries()) {
      const name = p.name.trim().slice(0, PLAYLIST_NAME_MAX) || 'Imported playlist';
      await this.playlists.createWithTracks(name, playlistIds[i]);
    }
    const now = Date.now();
    await this.library.bookmarkWithoutSaving(
      likedIds.map((id, i) => {
        const added = Date.parse(parsed.liked[i].addedAt ?? '');
        return { id, savedAt: Number.isFinite(added) ? added : now - i };
      }),
    );

    if (this._job()?.status === 'running') void this.run();
    return {
      playlists: parsed.playlists.length,
      liked: parsed.liked.length,
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
          const results = await this.remote.searchSite(matchQuery(toImported(item)), 'ytmusic', abort.signal);
          if (abort.signal.aborted) break;
          await this.applyResult(item, matchTrack(toImported(item), results));
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
