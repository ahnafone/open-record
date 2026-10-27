import { Injectable, inject, signal } from '@angular/core';
import {
  ImportSession,
  ImportSessionKind,
  StoragePort,
} from '@open-record/storage';
import type { ImportItemState } from './import.store';

export type { ImportSession, ImportSessionKind } from '@open-record/storage';

export type NewImportSession = Omit<ImportSession, 'id' | 'createdAt' | 'label'> & {
  /** Shown after the kind, e.g. a file or playlist name. Defaults to the date. */
  label?: string;
};

/** Longest stored label (the account copy allows 300 characters). */
const MAX_LABEL = 300;

const KIND_LABEL: Record<ImportSessionKind, string> = {
  files: 'Audio files',
  spotify: 'Spotify',
  youtube: 'YouTube',
};

/** "26 Oct 2026, 14:03" */
export function formatSessionDate(ms: number): string {
  return new Date(ms).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * A session's counts. Spotify sessions use live match states (`stateOf`, by
 * item key) while the import job still holds their items: "12 tracks ·
 * 9 matched · 2 to review · 1 not found" (zero parts left out). Otherwise
 * "12 added · 3 skipped · 1 failed" (zero counts other than added left out).
 */
export function importSessionCounts(
  s: ImportSession,
  stateOf?: (key: string) => ImportItemState | undefined,
): string {
  if ((s.kind === 'spotify' || s.kind === 'youtube') && stateOf) {
    const n: Record<ImportItemState, number> = { matched: 0, review: 0, unmatched: 0, pending: 0 };
    let known = 0;
    for (const key of s.trackIds) {
      const state = stateOf(key);
      if (!state) continue;
      n[state]++;
      known++;
    }
    if (known) {
      const parts = [`${s.trackIds.length} track${s.trackIds.length === 1 ? '' : 's'}`];
      if (n.matched) parts.push(`${n.matched} matched`);
      if (n.pending) parts.push(`${n.pending} matching`);
      if (n.review) parts.push(`${n.review} to review`);
      if (n.unmatched) parts.push(`${n.unmatched} not found`);
      return parts.join(' · ');
    }
  }
  const parts = [`${s.added} added`];
  if (s.skipped) parts.push(`${s.skipped} skipped`);
  if (s.failed) parts.push(`${s.failed} failed`);
  return parts.join(' · ');
}

function newId(): string {
  return globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * History of import runs (audio files and Spotify exports), newest first.
 * Holds labels, counts and track ids, never raw payloads. Synced to the
 * signed-in account by `SyncStore` (which watches `changes`).
 */
@Injectable({ providedIn: 'root' })
export class ImportSessionsStore {
  private readonly storage = inject(StoragePort);
  private readonly _sessions = signal<ImportSession[]>([]);
  private readonly _changes = signal(0);
  private loaded?: Promise<void>;

  readonly sessions = this._sessions.asReadonly();
  /** Bumped on every local change (not on synced ones), so sync can share it. */
  readonly changes = this._changes.asReadonly();

  constructor() {
    void this.load();
  }

  /** Resolves once the list has been read from storage. */
  load(): Promise<void> {
    return (this.loaded ??= this.reload());
  }

  async reload(): Promise<void> {
    try {
      this._sessions.set(await this.storage.importSessions.list());
    } catch {
      this._sessions.set([]);
    }
  }

  session(id: string): ImportSession | undefined {
    return this._sessions().find((s) => s.id === id);
  }

  async record(input: NewImportSession): Promise<ImportSession> {
    const createdAt = Date.now();
    const detail = input.label?.trim() || formatSessionDate(createdAt);
    const session: ImportSession = {
      id: newId(),
      kind: input.kind,
      createdAt,
      label: `${KIND_LABEL[input.kind]} · ${detail}`.slice(0, MAX_LABEL),
      added: input.added,
      skipped: input.skipped,
      failed: input.failed,
      trackIds: [...new Set(input.trackIds)],
    };
    await this.storage.importSessions.save(session);
    this._sessions.update((list) => [session, ...list.filter((s) => s.id !== session.id)]);
    this.changed();
    return session;
  }

  /** A track's id changed (its source link was replaced): repoint every session. */
  async replaceTrackId(oldId: string, newId: string): Promise<void> {
    await this.load();
    if (oldId === newId) return;
    const changed = this._sessions()
      .filter((s) => s.trackIds.includes(oldId))
      .map((s) => ({ ...s, trackIds: [...new Set(s.trackIds.map((id) => (id === oldId ? newId : id)))] }));
    if (!changed.length) return;
    for (const s of changed) await this.storage.importSessions.save(s);
    const byId = new Map(changed.map((s) => [s.id, s]));
    this._sessions.update((list) => list.map((s) => byId.get(s.id) ?? s));
    this.changed();
  }

  async delete(id: string): Promise<void> {
    await this.storage.importSessions.delete(id);
    this._sessions.update((list) => list.filter((s) => s.id !== id));
    this.changed();
  }

  /** Deletes every session of one kind (e.g. all Spotify sessions on Spotify data delete). */
  async deleteKind(kind: ImportSessionKind): Promise<void> {
    const all = await this.storage.importSessions.list();
    for (const s of all) {
      if (s.kind === kind) await this.storage.importSessions.delete(s.id);
    }
    this._sessions.update((list) => list.filter((s) => s.kind !== kind));
    this.changed();
  }

  /** Apply sessions the account copy won (saves or deletes), then reload the list. */
  async applySynced(changes: {
    save: readonly ImportSession[];
    remove: readonly string[];
  }): Promise<void> {
    await this.load();
    for (const s of changes.save) await this.storage.importSessions.save(s);
    for (const id of changes.remove) await this.storage.importSessions.delete(id);
    if (changes.save.length || changes.remove.length) await this.reload();
  }

  private changed(): void {
    this._changes.update((n) => n + 1);
  }
}
