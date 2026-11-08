import { Injectable, computed, inject, signal } from '@angular/core';
import type {
  AccessAction,
  AccessRequest,
  AccessStatus,
} from '@open-record/models';
import { AccessAdminService } from '@open-record/state';

export const FALLBACK_ERROR = 'Something went wrong. Try again.';

export type AccessCounts = Readonly<Record<AccessStatus, number>>;

/** Holds the admin's access-request list and per-row actions. */
@Injectable({ providedIn: 'root' })
export class AdminRequestsStore {
  private readonly service = inject(AccessAdminService);

  private readonly _requests = signal<readonly AccessRequest[]>([]);
  private readonly _loaded = signal(false);
  private readonly _loading = signal(false);
  private readonly _loadError = signal<string | null>(null);
  private readonly _busy = signal<ReadonlySet<string>>(new Set());
  private readonly _rowErrors = signal<Readonly<Record<string, string>>>({});

  readonly requests = this._requests.asReadonly();
  readonly loaded = this._loaded.asReadonly();
  readonly loading = this._loading.asReadonly();
  readonly loadError = this._loadError.asReadonly();
  /** Ids of rows with an action in flight. */
  readonly busy = this._busy.asReadonly();
  /** Last failed action message per request id. */
  readonly rowErrors = this._rowErrors.asReadonly();

  readonly counts = computed<AccessCounts>(() => {
    const counts: Record<AccessStatus, number> = {
      pending: 0,
      approved: 0,
      denied: 0,
      revoked: 0,
    };
    for (const r of this._requests()) counts[r.status]++;
    return counts;
  });

  /** Fetch the full list. Keeps the current rows visible if the refresh fails. */
  async load(): Promise<void> {
    if (this._loading()) return;
    this._loading.set(true);
    this._loadError.set(null);
    try {
      this._requests.set(await this.port().list());
      this._loaded.set(true);
    } catch (err) {
      this._loadError.set(messageOf(err));
    } finally {
      this._loading.set(false);
    }
  }

  /** Apply an action to one request; resolves to the updated request, or null on failure. */
  async decide(
    id: string,
    action: AccessAction,
  ): Promise<AccessRequest | null> {
    if (this._busy().has(id)) return null;
    this._busy.update((set) => new Set(set).add(id));
    this.clearRowError(id);
    try {
      const updated = await this.port().decide(id, action);
      this._requests.update((list) =>
        list.map((r) => (r.id === id ? updated : r)),
      );
      return updated;
    } catch (err) {
      this._rowErrors.update((errors) => ({ ...errors, [id]: messageOf(err) }));
      return null;
    } finally {
      this._busy.update((set) => {
        const next = new Set(set);
        next.delete(id);
        return next;
      });
    }
  }

  private port(): AccessAdminService {
    return this.service;
  }

  private clearRowError(id: string): void {
    if (!(id in this._rowErrors())) return;
    this._rowErrors.update((errors) => {
      const next = { ...errors };
      delete next[id];
      return next;
    });
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error && err.message ? err.message : FALLBACK_ERROR;
}
