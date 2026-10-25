import { Injectable, computed, inject, signal } from '@angular/core';
import type { DownloadSite, Track } from '@open-record/models';
import { LibraryStore } from './library.store';
import { RemoteDownloadPort, type RemoteDownloadProgress } from './ports';
import { isAbort, remoteErrorMessage } from './remote-errors';

export type DownloadStatus =
  'queued' | 'downloading' | 'processing' | 'saving' | 'done' | 'failed';

export interface DownloadItem {
  /** Queue id (not a track id). */
  id: string;
  title: string;
  artist: string;
  thumbnailUrl?: string;
  /** Page URL handed to the server. */
  url: string;
  site: string;
  phase: DownloadStatus;
  /** 0-100. */
  progress: number;
  /** Friendly failure text when `phase` is `failed`. */
  error?: string;
  /** The saved `local:` track once `phase` is `done`. */
  trackId?: string;
}

/** Downloads that run at once; the server queues the rest anyway. */
export const DOWNLOAD_CONCURRENCY = 1;

const ACTIVE: ReadonlySet<DownloadStatus> = new Set([
  'downloading',
  'processing',
  'saving',
]);

/**
 * Client-side queue of server downloads. Runs up to `DOWNLOAD_CONCURRENCY`
 * jobs, reports progress per item, and persists each finished track into the
 * library (imported tracks). Not persisted: the queue is per session.
 */
@Injectable({ providedIn: 'root' })
export class DownloadsStore {
  private readonly remote = inject(RemoteDownloadPort, { optional: true });
  private readonly library = inject(LibraryStore);

  private readonly _items = signal<readonly DownloadItem[]>([]);
  private readonly _lastSaved = signal<DownloadItem | null>(null);
  private readonly running = new Map<string, AbortController>();
  /** The remote track each item was queued from (hints title/artist/duration). */
  private readonly sources = new Map<string, Track>();
  private seq = 0;

  /** Every item, oldest first. */
  readonly items = this._items.asReadonly();
  /** Queued, running and failed items (what the downloads list shows). */
  readonly visible = computed(() =>
    this._items().filter((i) => i.phase !== 'done'),
  );
  readonly activeCount = computed(
    () =>
      this._items().filter((i) => i.phase === 'queued' || ACTIVE.has(i.phase))
        .length,
  );
  /** Most recently saved download, for a live announcement. */
  readonly lastSaved = this._lastSaved.asReadonly();
  /** Latest item per page URL (search rows look themselves up by URL). */
  readonly byUrl = computed(
    () => new Map(this._items().map((i) => [i.url, i])),
  );

  /** Search one site on the download server. Results are not playable until downloaded. */
  search(
    query: string,
    site: DownloadSite,
    signal?: AbortSignal,
  ): Promise<Track[]> {
    return this.port().searchSite(query, site, signal);
  }

  /** A pasted page link as a (not yet downloaded) track. */
  resolve(url: string, signal?: AbortSignal): Promise<Track> {
    return this.port().resolveUrl(url, signal);
  }

  private port(): RemoteDownloadPort {
    if (!this.remote)
      throw Object.assign(new Error('Downloading is not available.'), {
        name: 'RemoteConfigError',
      });
    return this.remote;
  }

  /** Reactive lookup of the latest item for a page URL. */
  itemFor(url: string | undefined): DownloadItem | undefined {
    return url ? this.byUrl().get(url) : undefined;
  }

  /**
   * Queue a remote track (from search or a resolved link). Returns the
   * existing item when that URL is already queued, running or done.
   */
  enqueue(track: Track): DownloadItem {
    const url = track.source?.url ?? '';
    if (!url) throw new Error('This record has no download link.');
    const existing = this.itemFor(url);
    if (existing && existing.phase !== 'failed') return existing;
    if (existing) this.dismiss(existing.id);
    const item: DownloadItem = {
      id: `dl-${++this.seq}`,
      title: track.title,
      artist: track.artist,
      url,
      site: track.source?.site ?? 'web',
      phase: 'queued',
      progress: 0,
    };
    if (track.artUrl) item.thumbnailUrl = track.artUrl;
    this.sources.set(item.id, track);
    this._items.update((all) => [...all, item]);
    this.pump();
    return item;
  }

  /** Run a failed item again. */
  retry(id: string): void {
    const item = this.find(id);
    if (!item || item.phase !== 'failed') return;
    this.patch(id, { phase: 'queued', progress: 0, error: undefined });
    this.pump();
  }

  /** Remove an item; a running one is cancelled. */
  dismiss(id: string): void {
    this.running.get(id)?.abort();
    this.running.delete(id);
    this.sources.delete(id);
    this._items.update((all) => all.filter((i) => i.id !== id));
    this.pump();
  }

  private pump(): void {
    if (!this.remote) return;
    while (this.running.size < DOWNLOAD_CONCURRENCY) {
      const next = this._items().find(
        (i) => i.phase === 'queued' && !this.running.has(i.id),
      );
      if (!next) return;
      void this.run(next, this.remote);
    }
  }

  private async run(
    item: DownloadItem,
    remote: RemoteDownloadPort,
  ): Promise<void> {
    const abort = new AbortController();
    this.running.set(item.id, abort);
    this.patch(item.id, { phase: 'downloading', progress: 0 });
    try {
      const track = await remote.downloadToLibrary(
        this.sources.get(item.id) ?? item.url,
        {
          signal: abort.signal,
          onProgress: (p) => {
            if (!abort.signal.aborted) this.patch(item.id, toPatch(p));
          },
        },
      );
      if (abort.signal.aborted) return;
      await this.library.addDownloaded(track);
      this.patch(item.id, { phase: 'done', progress: 100, trackId: track.id });
      this.sources.delete(item.id);
      this._lastSaved.set(this.find(item.id) ?? null);
    } catch (err) {
      if (abort.signal.aborted || isAbort(err)) return;
      this.patch(item.id, { phase: 'failed', error: remoteErrorMessage(err) });
    } finally {
      if (this.running.get(item.id) === abort) this.running.delete(item.id);
      this.pump();
    }
  }

  private find(id: string): DownloadItem | undefined {
    return this._items().find((i) => i.id === id);
  }

  private patch(id: string, changes: Partial<DownloadItem>): void {
    this._items.update((all) =>
      all.map((i) => {
        if (i.id !== id) return i;
        const next = { ...i, ...changes };
        if (next.error === undefined) delete next.error;
        return next;
      }),
    );
  }
}

function toPatch(p: RemoteDownloadProgress): Partial<DownloadItem> {
  const progress = Math.max(0, Math.min(100, Math.round(p.progress)));
  switch (p.phase) {
    case 'starting':
    case 'queued':
      return { phase: 'downloading', progress: 0 };
    case 'downloading':
    case 'processing':
      return { phase: p.phase, progress };
    default:
      // 'done' (server finished, file being fetched) and 'saving'.
      return { phase: 'saving', progress: 100 };
  }
}
