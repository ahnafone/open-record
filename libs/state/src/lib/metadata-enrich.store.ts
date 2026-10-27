import { Injectable, computed, inject, signal } from '@angular/core';
import { MAX_ENRICH_BATCH, type EnrichMatch, type EnrichQuery, type Track } from '@open-record/models';
import { SETTINGS_KEYS, StoragePort, type JsonValue } from '@open-record/storage';
import { LibraryStore } from './library.store';
import { RemoteServerPort } from './ports';
import { busyRetryAfterSec, isAbort, remoteErrorMessage } from './remote-errors';

export type EnrichStatus = 'idle' | 'running' | 'paused' | 'done';

export interface EnrichProgress {
  /** Songs queued for enrichment in this job. */
  total: number;
  /** Songs whose metadata was replaced by a confident catalogue match. */
  enriched: number;
  /** Songs checked without a confident match (left untouched). */
  unmatched: number;
  pending: number;
}

/** Persisted enrichment queue (settings key `youtubeImport`). Track ids and counts only. */
interface EnrichJob {
  version: 1;
  status: Exclude<EnrichStatus, 'idle'>;
  /** Track ids still to look up, in import order. */
  pending: string[];
  total: number;
  enriched: number;
  unmatched: number;
  error?: string;
  /** Failed batches in a row (unexpected errors). */
  attempts?: number;
}

/** Pause between enrichment batches (each batch is one rate-limited request). */
const PACE_MS = 3_000;
const RATE_LIMIT_WAIT_MS = 60_000;
const BUSY_WAIT_SEC = 10;
const MAX_ATTEMPTS = 3;
/** Matches below this are ignored even if the server returns them. */
const MIN_CONFIDENCE = 0.82;
const MAX_FIELD = 300;
const UNKNOWN_ARTIST = 'Unknown artist';
const PAUSING_ERRORS = new Set(['AuthError', 'NetworkError', 'RemoteConfigError']);
const NO_SERVER = 'Set up a download server in Settings to find song details.';
const NOT_SUPPORTED = 'This download server cannot look up song details. Update it, then try again.';

/**
 * Background song-detail lookup for YouTube imports. Asks the server for
 * catalogue metadata (YT Music, iTunes, Deezer, MusicBrainz) in paced batches
 * and replaces title/artist/album/year/genre/art on confident matches only,
 * never touching fields the user edited. The original title and uploader stay
 * in `track.source`. Fed by `ImportStore.startYoutube`, which shows its
 * progress in the same import job view. Playback never waits for it.
 */
@Injectable({ providedIn: 'root' })
export class MetadataEnrichStore {
  private readonly storage = inject(StoragePort);
  private readonly library = inject(LibraryStore);
  private readonly remote = inject(RemoteServerPort, { optional: true });

  private readonly _job = signal<EnrichJob | null>(null);
  private readonly _retryAt = signal<number | null>(null);

  readonly status = computed<EnrichStatus>(() => this._job()?.status ?? 'idle');
  /** Why enrichment paused (user-facing), or null. */
  readonly error = computed(() => this._job()?.error ?? null);
  /** Epoch ms enrichment resumes after a busy / rate-limit wait, or null. */
  readonly retryAt = this._retryAt.asReadonly();
  readonly progress = computed<EnrichProgress>(() => {
    const job = this._job();
    return {
      total: job?.total ?? 0,
      enriched: job?.enriched ?? 0,
      unmatched: job?.unmatched ?? 0,
      pending: job?.pending.length ?? 0,
    };
  });

  private readonly loaded: Promise<void>;
  private running = false;
  private abort: AbortController | null = null;

  constructor() {
    this.loaded = this.hydrate();
  }

  /** Startup: resume an enrichment queue left running. */
  async restore(): Promise<void> {
    await this.loaded;
    if (this._job()?.status === 'running') void this.run();
  }

  /** Queue tracks (by id) for a detail lookup. Starts the background run. */
  async enqueue(ids: readonly string[]): Promise<void> {
    await this.loaded;
    if (!this.remote?.enrich || !ids.length) return;
    const job = this._job();
    const queued = new Set(job?.pending ?? []);
    const add = ids.filter((id) => !queued.has(id));
    const keep = job && (job.status !== 'done' || job.pending.length);
    const next: EnrichJob = keep
      ? { ...job, status: job.status === 'paused' ? 'paused' : 'running', pending: [...job.pending, ...add], total: job.total + add.length }
      : { version: 1, status: 'running', pending: [...add], total: add.length, enriched: 0, unmatched: 0 };
    this._job.set(next);
    await this.persist();
    if (next.status === 'running') void this.run();
  }

  /** Stop after the current batch (resume later). */
  async pause(): Promise<void> {
    this.update((job) => (job.status === 'running' ? { ...job, status: 'paused' } : job));
    this.stopRunner();
    await this.persist();
  }

  /** Continue (also retries after a pausing error). */
  async resume(): Promise<void> {
    await this.loaded;
    const job = this._job();
    if (!job) return;
    const pending = job.pending.length > 0;
    this._job.set(withoutError({ ...job, status: pending ? 'running' : 'done', attempts: 0 }));
    await this.persist();
    if (pending) void this.run();
  }

  /** Stop for good: queued songs keep their YouTube metadata. */
  async cancel(): Promise<void> {
    await this.loaded;
    this.stopRunner();
    this.update((job) => withoutError({ ...job, status: 'done', pending: [] }));
    await this.persist();
  }

  /** Forget the finished queue. Songs and playlists stay. */
  async dismiss(): Promise<void> {
    await this.loaded;
    if (this._job()?.status === 'running') return;
    this.stopRunner();
    this._job.set(null);
    await this.storage.settings.delete(SETTINGS_KEYS.youtubeImport);
  }

  // ---- Queue ---------------------------------------------------------------

  private async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const abort = (this.abort = new AbortController());
    try {
      await this.library.ready();
      while (!abort.signal.aborted && this._job()?.status === 'running') {
        const job = this._job();
        if (!job) break;
        if (!job.pending.length) {
          this.update((j) => ({ ...j, status: 'done' }));
          break;
        }
        const remote = this.remote;
        if (!remote?.configured) {
          this.pauseWith(NO_SERVER);
          break;
        }
        if (!remote.enrich) {
          this.pauseWith(NOT_SUPPORTED);
          break;
        }
        const batchIds = job.pending.slice(0, MAX_ENRICH_BATCH);
        const tracks = batchIds.map((id) => this.library.track(id));
        // Songs removed from the library meanwhile are simply dropped.
        const live = tracks.filter((t): t is Track => !!t);
        try {
          const matches = live.length ? await remote.enrich(live.map(toQuery), abort.signal) : [];
          if (abort.signal.aborted) break;
          let enriched = 0;
          for (const [i, track] of live.entries()) {
            const match = matches[i];
            if (match && match.confidence >= MIN_CONFIDENCE && (await this.apply(track.id, match))) enriched++;
          }
          const done = new Set(batchIds);
          this.update((j) => ({
            ...j,
            pending: j.pending.filter((id) => !done.has(id)),
            enriched: j.enriched + enriched,
            unmatched: j.unmatched + (live.length - enriched),
            attempts: 0,
          }));
          await this.persist();
          await sleep(PACE_MS, abort.signal);
        } catch (error) {
          if (isAbort(error) || abort.signal.aborted) break;
          const name = error instanceof Error ? error.name : '';
          const status = (error as { status?: unknown } | null)?.status;
          if (name === 'busy') {
            await this.wait((busyRetryAfterSec(error) ?? BUSY_WAIT_SEC) * 1000, abort.signal);
          } else if (name === 'HttpError' && status === 429) {
            await this.wait(RATE_LIMIT_WAIT_MS, abort.signal);
          } else if (PAUSING_ERRORS.has(name)) {
            this.pauseWith(remoteErrorMessage(error));
            break;
          } else {
            const attempts = (this._job()?.attempts ?? 0) + 1;
            if (attempts >= MAX_ATTEMPTS) {
              // A batch that keeps failing is skipped (its songs keep YouTube metadata).
              const skip = new Set(batchIds);
              this.update((j) => ({
                ...j,
                pending: j.pending.filter((id) => !skip.has(id)),
                unmatched: j.unmatched + live.length,
                attempts: 0,
              }));
            } else {
              this.update((j) => ({ ...j, attempts }));
            }
            await this.persist();
            await sleep(PACE_MS * attempts, abort.signal);
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
   * Replace a track's metadata with a confident match (fields the user edited
   * stay). Saves the metadata entry and, for downloaded songs, the stored
   * record. Never marks fields as user-edited. Resolves true when changed.
   */
  private async apply(id: string, match: EnrichMatch): Promise<boolean> {
    const current = this.library.track(id);
    if (!current) return false;
    const next = enrichTrack(current, match);
    if (!next) return false;
    const metadata = new Set(this.library.metadataIds());
    if (metadata.has(id)) await this.library.addMetadataTracks([next]);
    const record = this.library.storedRecord(id);
    if (record) await this.library.storeRecord({ ...record, track: { ...record.track, ...pickEnriched(next) } });
    if (!metadata.has(id) && !record) return false;
    return true;
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

  // ---- State ---------------------------------------------------------------

  private update(change: (job: EnrichJob) => EnrichJob): void {
    const job = this._job();
    if (!job) return;
    const next = change(job);
    if (next !== job) this._job.set(next);
  }

  private async persist(): Promise<void> {
    const job = this._job();
    if (job) await this.storage.settings.set(SETTINGS_KEYS.youtubeImport, job as unknown as JsonValue);
  }

  private async hydrate(): Promise<void> {
    try {
      const raw = await this.storage.settings.get<JsonValue>(SETTINGS_KEYS.youtubeImport);
      const job = raw as unknown as EnrichJob | undefined;
      if (job && job.version === 1 && Array.isArray(job.pending)) {
        this._job.set({
          ...job,
          pending: job.pending.filter((id): id is string => typeof id === 'string'),
          total: num(job.total),
          enriched: num(job.enriched),
          unmatched: num(job.unmatched),
        });
      }
    } catch {
      // No queue: nothing to resume.
    }
  }
}

/** The lookup sent for a track: its cleaned title and artist (uploader when unknown). */
function toQuery(track: Track): EnrichQuery {
  const artist =
    track.artist && track.artist !== UNKNOWN_ARTIST ? track.artist : (track.source?.originalArtist ?? '');
  const query: EnrichQuery = { title: track.title.slice(0, MAX_FIELD), artist: artist.slice(0, MAX_FIELD) };
  if (track.durationSec) query.durationSec = track.durationSec;
  if (track.album) query.album = track.album.slice(0, MAX_FIELD);
  return query;
}

/**
 * `track` with a match's catalogue fields (non-empty ones only; user-edited
 * fields kept), the source link untouched and the pre-enrichment title and
 * artist kept in `source`. Null when nothing would change.
 */
export function enrichTrack(track: Track, match: EnrichMatch): Track | null {
  const edited = new Set(track.userEdited ?? []);
  const next: Track = { ...track };
  const text = (v: string | undefined) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, MAX_FIELD) : undefined);
  const title = text(match.title);
  const artist = text(match.artist);
  const album = text(match.album);
  const genre = text(match.genre);
  if (title && !edited.has('title')) next.title = title;
  if (artist && !edited.has('artist')) next.artist = artist;
  if (album && !edited.has('album')) next.album = album;
  if (genre && !edited.has('genre')) next.genre = genre;
  if (match.year && Number.isInteger(match.year) && !edited.has('year')) next.year = match.year;
  if (match.artUrl && /^https:\/\//.test(match.artUrl)) next.artUrl = match.artUrl;
  const changed = (['title', 'artist', 'album', 'genre', 'year', 'artUrl'] as const).some((k) => next[k] !== track[k]);
  if (!changed) return null;
  if (track.source) {
    next.source = { ...track.source };
    next.source.originalTitle ??= track.title;
    if (track.artist && track.artist !== UNKNOWN_ARTIST) next.source.originalArtist ??= track.artist;
  }
  return next;
}

/** The fields enrichment may change (applied onto a stored record's track). */
function pickEnriched(t: Track): Partial<Track> {
  const out: Partial<Track> = { title: t.title, artist: t.artist };
  if (t.album !== undefined) out.album = t.album;
  if (t.genre !== undefined) out.genre = t.genre;
  if (t.year !== undefined) out.year = t.year;
  if (t.artUrl !== undefined) out.artUrl = t.artUrl;
  if (t.source) out.source = t.source;
  return out;
}

function withoutError(job: EnrichJob): EnrichJob {
  const next = { ...job };
  delete next.error;
  return next;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
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
