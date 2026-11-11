import {
  StackFullError,
  StackSyncPort,
  type SyncStackEntry,
  type SyncStackMove,
  type SyncStackPushResult,
  type SyncTrack,
} from '@open-record/state';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { SupabaseAuth } from './supabase-auth';
import { pageAll } from './supabase-sync';

/** Rows per upsert or delete request. */
const CHUNK = 500;
/** Single-row updates sent at once (one request each). */
const MOVE_CHUNK = 25;

interface StackRow {
  entry_id: string;
  position: number;
  track: unknown;
}

interface StackUpsertRow {
  user_id: string;
  entry_id: string;
  position: number;
  track: SyncTrack;
}

/** Result of upserting a chunk: rows the cloud refused, and rows over the cap. */
interface UpsertOutcome {
  rejected: string[];
  full: string[];
}

const STACK_COLUMNS = 'entry_id,position,track';

/**
 * The cap trigger (`stack_entries_enforce_cap`) raises `check_violation`
 * (SQLSTATE 23514) with this message. Other check failures (23514 for a bad
 * row) are not the cap.
 */
function isCapError(error: { code?: string; message: string }): boolean {
  return error.code === '23514' && error.message.includes('Your Stack is full');
}

/**
 * Your Stack over the signed-in Supabase session (the client is shared with
 * `SupabaseAuth`). One row per entry: row-level security scopes every query to
 * the user, and the store decides what to write.
 */
export class SupabaseStackSync extends StackSyncPort {
  constructor(private readonly auth: SupabaseAuth) {
    super();
  }

  async userId(): Promise<string | null> {
    const client = await this.auth.sharedClient();
    if (!client) return null;
    const { data } = await client.auth.getSession();
    return data.session?.user.id ?? null;
  }

  async pull(): Promise<SyncStackEntry[]> {
    const client = await this.requireClient();
    const rows = await pageAll<StackRow>(
      client,
      'stack_entries',
      STACK_COLUMNS,
      ['position', 'entry_id'],
    );
    const out: SyncStackEntry[] = [];
    for (const r of rows) {
      // Untrusted: a row whose track is not an object is left for the store to drop.
      if (!r.track || typeof r.track !== 'object') continue;
      out.push({
        entryId: r.entry_id,
        position: r.position,
        track: r.track as SyncTrack,
      });
    }
    return out;
  }

  async push(changes: {
    upsert: SyncStackEntry[];
    move: SyncStackMove[];
    remove: string[];
  }): Promise<SyncStackPushResult> {
    const client = await this.requireClient();
    const userId = await this.userId();
    if (!userId) throw new Error('Sign in to sync.');
    const rows: StackUpsertRow[] = changes.upsert.map((e) => ({
      user_id: userId,
      entry_id: e.entryId,
      position: e.position,
      track: e.track,
    }));
    // Removes first: they free cap room for the upserts below.
    for (let i = 0; i < changes.remove.length; i += CHUNK) {
      const { error } = await client
        .from('stack_entries')
        .delete()
        .eq('user_id', userId)
        .in('entry_id', changes.remove.slice(i, i + CHUNK));
      if (error) throw new Error(error.message);
    }
    const rejected: string[] = [];
    const full: string[] = [];
    for (let i = 0; i < rows.length; i += CHUNK) {
      const result = await this.upsertRows(client, rows.slice(i, i + CHUNK));
      rejected.push(...result.rejected);
      full.push(...result.full);
    }
    // Over the cap: the moves wait for the caller's retry, which sends them
    // with the rest of the pending state.
    if (full.length) throw new StackFullError(full);
    // Position-only changes are updates, never upserts: a row another device
    // deleted matches nothing and is not re-created.
    for (let i = 0; i < changes.move.length; i += MOVE_CHUNK) {
      const results = await Promise.all(
        changes.move.slice(i, i + MOVE_CHUNK).map((m) =>
          client
            .from('stack_entries')
            .update({ position: m.position })
            .eq('user_id', userId)
            .eq('entry_id', m.entryId),
        ),
      );
      const failed = results.find((r) => r.error);
      if (failed?.error) throw new Error(failed.error.message);
    }
    return { rejected };
  }

  /**
   * Upsert one chunk. A cap failure or another check failure (23514) halves the
   * chunk and retries each half, so only rows that fail alone are reported:
   * a cap-failing row goes to `full` (the store drops it), a bad row to
   * `rejected` (it stays on this device). One failing row never blocks the
   * others. Other errors throw.
   */
  private async upsertRows(
    client: SupabaseClient,
    rows: StackUpsertRow[],
  ): Promise<UpsertOutcome> {
    if (!rows.length) return { rejected: [], full: [] };
    const { error } = await client
      .from('stack_entries')
      .upsert(rows, { onConflict: 'user_id,entry_id' });
    if (!error) return { rejected: [], full: [] };
    const cap = isCapError(error);
    if (!cap && error.code !== '23514') throw new Error(error.message);
    if (rows.length === 1) {
      return cap
        ? { rejected: [], full: [rows[0].entry_id] }
        : { rejected: [rows[0].entry_id], full: [] };
    }
    const half = Math.ceil(rows.length / 2);
    const first = await this.upsertRows(client, rows.slice(0, half));
    const second = await this.upsertRows(client, rows.slice(half));
    return {
      rejected: [...first.rejected, ...second.rejected],
      full: [...first.full, ...second.full],
    };
  }

  private async requireClient(): Promise<SupabaseClient> {
    const client = await this.auth.sharedClient();
    if (!client) throw new Error('Accounts are not set up.');
    return client;
  }
}
