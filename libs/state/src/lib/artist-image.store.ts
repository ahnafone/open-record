import { Injectable, inject, signal, type Signal, type WritableSignal } from '@angular/core';
import { artistKey } from '@open-record/models';
import { lookupArtistImage, type MetadataFetch } from '@open-record/metadata-lookup';
import { StoragePort, type ArtistImageRecord } from '@open-record/storage';
import { METADATA_FETCH, NetworkStatusPort } from './ports';

const DAY_MS = 24 * 60 * 60 * 1000;
const HIT_TTL_MS = 7 * DAY_MS;
const MISS_TTL_MS = DAY_MS;
/** Deezer lookups in flight at once. */
const MAX_CONCURRENT = 2;

const NO_ARTIST: Signal<string | null> = signal<string | null>(null).asReadonly();

function isFresh(record: ArtistImageRecord): boolean {
  return Date.now() - record.fetchedAt < (record.imageUrl ? HIT_TTL_MS : MISS_TTL_MS);
}

/**
 * Artist portraits from Deezer. `image(name)` returns a signal that starts
 * null and fills in once the portrait is known: from the persisted cache
 * (hits kept a week, misses a day), otherwise from a lookup. Lookups need the
 * injected `METADATA_FETCH` and a connection, run at most two at a time, and
 * share one request per artist. Failed lookups are not stored, so a later
 * `image()` call retries.
 */
@Injectable({ providedIn: 'root' })
export class ArtistImageStore {
  private readonly storage = inject(StoragePort);
  private readonly fetchFn: MetadataFetch | null = inject(METADATA_FETCH, { optional: true });
  private readonly network = inject(NetworkStatusPort, { optional: true });

  private readonly signals = new Map<string, WritableSignal<string | null>>();
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  /** Portrait URL for an artist, or null while unknown or when there is none. */
  image(name: string): Signal<string | null> {
    const key = artistKey(name);
    if (!key) return NO_ARTIST;
    const existing = this.signals.get(key);
    if (existing) return existing.asReadonly();

    const sig = signal<string | null>(null);
    this.signals.set(key, sig);
    void this.load(key, name, sig);
    return sig.asReadonly();
  }

  private async load(key: string, name: string, sig: WritableSignal<string | null>): Promise<void> {
    const cached = await this.storage.artistImages.get(key).catch(() => undefined);
    if (cached && isFresh(cached)) {
      sig.set(cached.imageUrl);
      return;
    }
    const online = (await this.network?.current().catch(() => null))?.connected ?? true;
    if (!this.fetchFn || !online) {
      sig.set(cached?.imageUrl ?? null);
      return;
    }

    let imageUrl: string | null;
    try {
      const fetchFn = this.fetchFn;
      const found = await this.queued(() => lookupArtistImage(name, fetchFn));
      imageUrl = found?.imageUrl ?? null;
    } catch {
      // Not stored: release the key so the next image() call retries.
      sig.set(cached?.imageUrl ?? null);
      this.signals.delete(key);
      return;
    }

    sig.set(imageUrl);
    await this.storage.artistImages
      .save({ key, name, imageUrl, fetchedAt: Date.now() })
      .catch(() => undefined);
  }

  /** Runs `task` once one of the `MAX_CONCURRENT` slots is free. Slots pass directly to waiters. */
  private async queued<T>(task: () => Promise<T>): Promise<T> {
    if (this.active < MAX_CONCURRENT) this.active++;
    else await new Promise<void>((resolve) => this.waiting.push(resolve));
    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}
