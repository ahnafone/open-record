import {
  Injectable,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import type { Playlist } from '@open-record/models';
import { SETTINGS_KEYS, StoragePort, type JsonValue } from '@open-record/storage';
import { AuthStore } from './auth.store';
import { ImportSessionsStore, type ImportSession } from './import-sessions.store';
import { ImportStore } from './import.store';
import { LibraryStore } from './library.store';
import { PlaylistsStore } from './playlists.store';
import {
  NetworkStatusPort,
  SyncPort,
  type SyncImportSession,
  type SyncLibraryItem,
  type SyncPlaylist,
  type SyncTrack,
} from './ports';
import {
  contentHash,
  emptyLedger,
  fromSyncTrack,
  importSessionContent,
  mergeRecords,
  playlistContent,
  readLedger,
  stampLocal,
  toSyncTrack,
  type SyncLedger,
  type SyncLedgerEntry,
} from './sync-merge';

/**
 * - `off`: sync is not built in, no project is configured, or signed out.
 * - `idle`: signed in; nothing running (see `lastSyncedAt` / `error`).
 */
export type SyncStatus = 'off' | 'idle' | 'syncing' | 'error';

/** Foreground resumes closer together than this do not sync again. */
const RESUME_THROTTLE_MS = 60_000;
/** Wait after a local library or playlist change before syncing it. */
const CHANGE_DEBOUNCE_MS = 3_000;
/** While the app is open and visible, check the cloud copy this often. */
const POLL_MS = 60_000;

type SessionContent = Omit<SyncImportSession, 'updatedAt' | 'deletedAt'>;

/** What a library entry's hash covers (`savedAt` only orders, it is not compared). */
interface LibraryContent {
  track: SyncTrack;
  saved: boolean;
}

/**
 * Account sync: keeps the signed-in user's library metadata (Spotify
 * placeholders, matched tracks, bookmarks), playlists and import history in
 * step with the
 * cloud copy behind `SyncPort`. Metadata only: audio and device files never
 * leave the device. Conflicts resolve last-write-wins per record; deletions
 * travel as tombstones.
 *
 * Runs on sign-in, when the network comes back, when the app returns to the
 * foreground, after an import finishes matching, when import history changes
 * here (so deleted sessions leave the account too), and on `syncNow()`. A no-op
 * when signed out or when no `SyncPort` is provided.
 */
@Injectable({ providedIn: 'root' })
export class SyncStore {
  private readonly port = inject(SyncPort, { optional: true });
  private readonly auth = inject(AuthStore);
  private readonly storage = inject(StoragePort);
  private readonly library = inject(LibraryStore);
  private readonly playlists = inject(PlaylistsStore);
  private readonly imports = inject(ImportStore);
  private readonly sessions = inject(ImportSessionsStore);
  private readonly network = inject(NetworkStatusPort, { optional: true });

  private readonly _running = signal(false);
  private readonly _error = signal<string | null>(null);
  private readonly _lastSyncedAt = signal<number | null>(null);

  /** Sync is built into this app (a `SyncPort` is provided). */
  readonly available = !!this.port;
  /** Signed in with sync available: syncing can run. */
  readonly enabled = computed(() => this.available && this.auth.signedIn());
  readonly status = computed<SyncStatus>(() => {
    if (!this.enabled()) return 'off';
    if (this._running()) return 'syncing';
    return this._error() ? 'error' : 'idle';
  });
  /** User-facing message of the last failed sync, or null. */
  readonly error = this._error.asReadonly();
  /** Epoch ms of the last successful sync for the signed-in account, or null. */
  readonly lastSyncedAt = this._lastSyncedAt.asReadonly();

  private started = false;
  private seenUser: string | null = null;
  private current: Promise<void> | null = null;
  private again = false;
  private lastAttempt = 0;

  constructor() {
    if (!this.port) return;
    // Sign-in (or a switch of account): load its last sync time, then sync.
    effect(() => {
      const id = this.auth.signedIn() ? (this.auth.user()?.id ?? null) : null;
      if (id === this.seenUser) return;
      this.seenUser = id;
      untracked(() => {
        this._error.set(null);
        this._lastSyncedAt.set(null);
        if (id && this.started) void this.onSignedIn(id);
      });
    });
    // An import finished matching: share the results.
    let importStatus = this.imports.status();
    effect(() => {
      const next = this.imports.status();
      const finished = importStatus === 'running' && next === 'done';
      importStatus = next;
      if (finished) untracked(() => void this.syncNow());
    });
    // Saves, unsaves, new tracks or playlist edits made here (or applied from
    // the cloud, which settles after one quiet pass).
    let firstRun = true;
    effect(() => {
      this.library.savedIds();
      this.library.metadataIds();
      this.playlists.playlists();
      if (firstRun) {
        firstRun = false;
        return;
      }
      untracked(() => {
        if (this.started && this.enabled()) this.scheduleChangeSync();
      });
    });
    // Import history changed on this device (recorded, repointed, deleted).
    let sessionChanges = this.sessions.changes();
    effect(() => {
      const next = this.sessions.changes();
      if (next === sessionChanges) return;
      sessionChanges = next;
      untracked(() => void this.syncNow());
    });
  }

  private changeTimer: ReturnType<typeof setTimeout> | null = null;

  /** Library or playlist changed on this device: sync soon (batched). */
  private scheduleChangeSync(): void {
    if (this.changeTimer) clearTimeout(this.changeTimer);
    this.changeTimer = setTimeout(() => {
      this.changeTimer = null;
      void this.syncNow();
    }, CHANGE_DEBOUNCE_MS);
  }

  /** Begin syncing (called once at app start). */
  start(): void {
    if (!this.port || this.started) return;
    this.started = true;
    if (this.seenUser) void this.onSignedIn(this.seenUser);
    this.network?.onChange((state) => {
      if (state.connected) void this.syncNow();
    });
    // Pick up changes made on other devices while this one stays open.
    if (typeof setInterval === 'function')
      setInterval(() => {
        if (typeof document === 'undefined' || document.visibilityState === 'visible')
          void this.syncNow();
      }, POLL_MS);
    if (typeof document !== 'undefined')
      document.addEventListener('visibilitychange', () => {
        if (
          document.visibilityState === 'visible' &&
          Date.now() - this.lastAttempt > RESUME_THROTTLE_MS
        )
          void this.syncNow();
      });
  }

  /**
   * Sync now. A call while a sync runs queues one more pass (so the latest
   * changes are included) and resolves when that finishes. Never rejects:
   * failures land in `error`.
   */
  syncNow(): Promise<void> {
    if (!this.enabled()) return Promise.resolve();
    if (this.current) {
      this.again = true;
      return this.current;
    }
    this.current = this.loop().finally(() => {
      this.current = null;
    });
    return this.current;
  }

  private async onSignedIn(userId: string): Promise<void> {
    const ledger = await this.readLedger();
    if (ledger?.userId === userId && ledger.lastSyncedAt)
      this._lastSyncedAt.set(ledger.lastSyncedAt);
    await this.syncNow();
  }

  private async loop(): Promise<void> {
    this._running.set(true);
    try {
      do {
        this.again = false;
        this.lastAttempt = Date.now();
        try {
          await this.syncOnce();
          this._error.set(null);
        } catch (err) {
          this._error.set(syncErrorMessage(err));
          return;
        }
      } while (this.again && this.enabled());
    } finally {
      this._running.set(false);
    }
  }

  private async syncOnce(): Promise<void> {
    const port = this.port;
    if (!port) return;
    const userId = await port.userId();
    if (!userId || userId !== this.auth.user()?.id) return;
    await Promise.all([
      this.library.ready(),
      this.playlists.ready(),
      this.sessions.load(),
    ]);

    const stored = await this.readLedger();
    const ledger = stored?.userId === userId ? stored : emptyLedger(userId);
    const firstSync = !ledger.lastSyncedAt;
    const now = Date.now();

    // ---- Local state with clocks ----
    const lib = await this.collectLibrary();
    // Saved or listed ids whose metadata is not loaded (e.g. a streamed track
    // after a restart) are not deletions: keep their ledger entries as they are.
    const keptLib = Object.fromEntries(
      Object.entries(ledger.library).filter(
        ([id, e]) => !lib.content.has(id) && lib.referenced.has(id) && !e.d,
      ),
    );
    const libLedger = Object.fromEntries(
      Object.entries(ledger.library).filter(([id]) => !(id in keptLib)),
    );
    const localLib = new Map<string, SyncLibraryItem>();
    for (const [id, s] of stampLocal(lib.content, libLedger, now, { firstSync })) {
      localLib.set(id, {
        trackId: id,
        ...(s.content ?? { saved: false }),
        ...(s.content?.saved && lib.savedAt.has(id)
          ? { savedAt: lib.savedAt.get(id) }
          : {}),
        updatedAt: s.updatedAt,
        ...(s.deletedAt ? { deletedAt: s.deletedAt } : {}),
      });
    }

    const plContent = new Map(
      this.playlists.playlists().map((p) => [p.id, toSyncPlaylist(p)]),
    );
    const localPl = new Map<string, SyncPlaylist>();
    for (const [id, s] of stampLocal(plContent, ledger.playlists, now, {
      firstSync,
      clockOf: (p) => p.updatedAt,
    })) {
      localPl.set(
        id,
        s.content ?? tombstonePlaylist(id, s.updatedAt, s.deletedAt ?? now),
      );
    }

    const sessionLedger = ledger.importSessions ?? {};
    const localSessions = new Map<string, SyncImportSession>();
    for (const [id, s] of stampLocal(this.sessionContent(), sessionLedger, now, {
      firstSync,
    })) {
      localSessions.set(
        id,
        s.content
          ? { ...s.content, updatedAt: s.updatedAt }
          : tombstoneSession(id, s.updatedAt, s.deletedAt ?? now),
      );
    }

    // ---- Merge with the cloud copy ----
    const remote = await port.pull();
    const lMerge = mergeRecords(
      localLib,
      new Map(remote.library.map((i) => [i.trackId, i])),
      (a, b) => libraryHash(a) === libraryHash(b),
    );
    const pMerge = mergeRecords(
      localPl,
      new Map(remote.playlists.map((p) => [p.id, p])),
      (a, b) => playlistHash(a) === playlistHash(b),
    );
    const sMerge = mergeRecords(
      localSessions,
      new Map(remote.importSessions.map((s) => [s.id, s])),
      (a, b) => sessionHash(a) === sessionHash(b),
    );
    // First-sync clocks of 0 only lose ties; uploads carry a real time.
    for (const i of lMerge.push) if (!i.updatedAt) i.updatedAt = now;
    for (const s of sMerge.push) if (!s.updatedAt) s.updatedAt = now;
    if (lMerge.push.length || pMerge.push.length || sMerge.push.length)
      await port.push({
        library: lMerge.push,
        playlists: pMerge.push,
        importSessions: sMerge.push,
      });

    // ---- Apply what the cloud won ----
    await this.applyLibrary(lMerge.apply);
    await this.applyPlaylists(pMerge.apply);
    await this.sessions.applySynced({
      save: sMerge.apply.filter((s) => !s.deletedAt).map(fromSyncSession),
      remove: sMerge.apply.filter((s) => s.deletedAt).map((s) => s.id),
    });

    // ---- Remember what is now agreed ----
    const libClock = new Map<string, SyncLibraryItem>(localLib);
    for (const i of lMerge.apply) libClock.set(i.trackId, i);
    const plClock = new Map<string, SyncPlaylist>(localPl);
    for (const p of pMerge.apply) plClock.set(p.id, p);
    const sessionClock = new Map<string, SyncImportSession>(localSessions);
    for (const s of sMerge.apply) sessionClock.set(s.id, s);

    const after = await this.collectLibrary();
    const afterPl = new Map(
      this.playlists.playlists().map((p) => [p.id, toSyncPlaylist(p)]),
    );
    const next: SyncLedger = {
      v: 1,
      userId,
      lastSyncedAt: Date.now(),
      library: {
        ...keptLib,
        ...nextLedger(after.content, libClock, contentHash),
      },
      playlists: nextLedger(afterPl, plClock, (p) => contentHash(p)),
      importSessions: nextLedger(this.sessionContent(), sessionClock, contentHash),
    };
    await this.storage.settings.set(
      SETTINGS_KEYS.syncState,
      next as unknown as JsonValue,
    );
    this._lastSyncedAt.set(next.lastSyncedAt ?? null);
  }

  /**
   * The library as it syncs: metadata-only tracks, saved tracks and playlist
   * tracks (never `local:` file imports). `referenced` holds every saved or
   * listed id, known or not.
   */
  private async collectLibrary(): Promise<{
    content: Map<string, LibraryContent>;
    savedAt: Map<string, number>;
    referenced: Set<string>;
  }> {
    const savedAt = new Map(
      (await this.storage.savedRecords.entries()).map((r) => [r.trackId, r.savedAt]),
    );
    const saved = new Set(this.library.savedIds());
    const referenced = new Set<string>(saved);
    for (const p of this.playlists.playlists())
      for (const id of p.trackIds) referenced.add(id);
    const content = new Map<string, LibraryContent>();
    for (const id of new Set([...this.library.metadataIds(), ...referenced])) {
      if (id.startsWith('local:')) continue;
      const track = this.library.track(id);
      if (!track) continue;
      content.set(id, { track: toSyncTrack(track), saved: saved.has(id) });
    }
    return { content, savedAt, referenced };
  }

  /** Import history as it syncs (labels, counts and track ids only). */
  private sessionContent(): Map<string, SessionContent> {
    return new Map(
      this.sessions.sessions().map((s) => [s.id, importSessionContent(s)]),
    );
  }

  private async applyLibrary(items: readonly SyncLibraryItem[]): Promise<void> {
    if (!items.length) return;
    const addMeta = [];
    const bookmark: { id: string; savedAt?: number }[] = [];
    const unsave: string[] = [];
    const forget: string[] = [];
    for (const item of items) {
      const id = item.trackId;
      if (id.startsWith('local:')) continue;
      if (item.deletedAt || !item.track) {
        if (this.library.isSaved(id)) unsave.push(id);
        forget.push(id);
        continue;
      }
      if (!this.library.track(id) || this.library.isMetadataOnly(id))
        addMeta.push(fromSyncTrack(item.track));
      if (item.saved && !this.library.isSaved(id))
        bookmark.push({ id, savedAt: item.savedAt });
      else if (!item.saved && this.library.isSaved(id)) unsave.push(id);
    }
    await this.library.addMetadataTracks(addMeta);
    await this.library.bookmarkWithoutSaving(bookmark);
    for (const id of unsave) await this.library.setSaved(id, false);
    await this.library.removeMetadataTracks(forget);
  }

  private async applyPlaylists(items: readonly SyncPlaylist[]): Promise<void> {
    for (const p of items) {
      if (p.deletedAt) {
        await this.playlists.delete(p.id);
        continue;
      }
      const playlist: Playlist = {
        id: p.id,
        name: p.name,
        visibility: p.visibility,
        trackIds: [...new Set(p.trackIds)],
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
      };
      if (p.autoDownload) playlist.autoDownload = true;
      // The cloud copy may not carry add dates; keep the local ones then.
      const addedAt = validAddedAt(p.addedAt) ?? this.playlists.playlist(p.id)?.addedAt;
      if (addedAt) playlist.addedAt = { ...addedAt };
      await this.playlists.applySynced(playlist);
    }
  }

  private async readLedger(): Promise<SyncLedger | null> {
    try {
      return readLedger(await this.storage.settings.get(SETTINGS_KEYS.syncState));
    } catch {
      return null;
    }
  }
}

function toSyncPlaylist(p: Playlist): SyncPlaylist {
  return {
    id: p.id,
    name: p.name,
    visibility: p.visibility,
    autoDownload: !!p.autoDownload,
    trackIds: [...p.trackIds],
    ...(p.addedAt ? { addedAt: { ...p.addedAt } } : {}),
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

/** Untrusted `addedAt` from the cloud: finite positive numbers only, else undefined. */
function validAddedAt(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Record<string, number> = {};
  for (const [id, at] of Object.entries(value)) {
    if (typeof at === 'number' && Number.isFinite(at) && at > 0) out[id] = at;
  }
  return Object.keys(out).length ? out : undefined;
}

function tombstonePlaylist(id: string, updatedAt: number, deletedAt: number): SyncPlaylist {
  return {
    id,
    name: '',
    visibility: 'private',
    autoDownload: false,
    trackIds: [],
    createdAt: deletedAt,
    updatedAt,
    deletedAt,
  };
}

function tombstoneSession(id: string, updatedAt: number, deletedAt: number): SyncImportSession {
  return {
    id,
    kind: 'files',
    label: '',
    createdAt: deletedAt,
    added: 0,
    skipped: 0,
    failed: 0,
    trackIds: [],
    updatedAt,
    deletedAt,
  };
}

function fromSyncSession(s: SyncImportSession): ImportSession {
  return {
    id: s.id,
    kind: s.kind,
    createdAt: s.createdAt,
    label: s.label,
    added: s.added,
    skipped: s.skipped,
    failed: s.failed,
    trackIds: [...new Set(s.trackIds)],
  };
}

function sessionHash(s: SyncImportSession): string {
  return s.deletedAt ? '' : contentHash(importSessionContent(s));
}

function libraryHash(i: SyncLibraryItem): string {
  return i.deletedAt || !i.track ? '' : contentHash({ track: i.track, saved: i.saved });
}

function playlistHash(p: SyncPlaylist): string {
  return p.deletedAt ? '' : contentHash(playlistContent(p));
}

/**
 * Ledger after a sync: every id present locally with the clock it now
 * agrees on, and tombstones for ids that are gone. Ids that appeared during
 * the sync (no clock yet) are left for the next one.
 */
function nextLedger<C, R extends { updatedAt: number; deletedAt?: number }>(
  current: ReadonlyMap<string, C>,
  clocks: ReadonlyMap<string, R>,
  hash: (content: C) => string,
): Record<string, SyncLedgerEntry> {
  const out: Record<string, SyncLedgerEntry> = {};
  for (const [id, content] of current) {
    const clock = clocks.get(id);
    // Still here after a tombstone won (e.g. a playlist lists it): no entry,
    // so the next sync uploads it as new instead of re-applying the delete.
    if (clock && !clock.deletedAt)
      out[id] = { h: hash(content), u: clock.updatedAt };
  }
  for (const [id, r] of clocks) {
    if (current.has(id) || !r.deletedAt) continue;
    out[id] = { h: '', u: r.updatedAt, d: r.deletedAt };
  }
  return out;
}

function syncErrorMessage(err: unknown): string {
  if (typeof navigator !== 'undefined' && navigator.onLine === false)
    return 'You are offline. Sync will retry when you reconnect.';
  const detail = err instanceof Error && err.message ? ` ${err.message}` : '';
  return `Could not sync.${detail}`;
}
