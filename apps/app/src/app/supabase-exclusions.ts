import {
  EXCLUSION_WINDOW_MS,
  ExclusionSyncPort,
  type SyncExclusion,
} from '@open-record/state';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { SupabaseAuth } from './supabase-auth';
import { pageAll } from './supabase-sync';

interface ExclusionRow {
  track_id: string;
  excluded_at: string;
}

const EXCLUSION_COLUMNS = 'track_id,excluded_at';

/**
 * Recent exclusions over the signed-in Supabase session (the client is shared
 * with `SupabaseAuth`). Row-level security scopes every query to the user. The
 * `record_exclusions` RPC keeps the later time per song and trims the window
 * and the per-user cap; the store decides what to send and drops rows outside
 * the 12-hour window on pull.
 */
export class SupabaseExclusionSync extends ExclusionSyncPort {
  constructor(private readonly auth: SupabaseAuth) {
    super();
  }

  async pull(): Promise<Record<string, number>> {
    const client = await this.requireClient();
    // Only rows inside the window: older ones exclude nothing and are not fetched.
    const cutoff = new Date(Date.now() - EXCLUSION_WINDOW_MS).toISOString();
    const rows = await pageAll<ExclusionRow>(
      client,
      'recent_exclusions',
      EXCLUSION_COLUMNS,
      ['track_id'],
      { column: 'excluded_at', value: cutoff },
    );
    const out: Record<string, number> = {};
    for (const r of rows) {
      const at = Date.parse(r.excluded_at);
      // Untrusted: a row without a usable time or id is left for the store to drop.
      if (typeof r.track_id !== 'string' || !Number.isFinite(at)) continue;
      out[r.track_id] = Math.max(out[r.track_id] ?? 0, at);
    }
    return out;
  }

  async push(items: Array<SyncExclusion>): Promise<void> {
    if (!items.length) return;
    const client = await this.requireClient();
    const { error } = await client.rpc('record_exclusions', {
      p_items: items.map((i) => ({ track_id: i.trackId, at: i.at })),
    });
    if (error) throw new Error(error.message);
  }

  private async requireClient(): Promise<SupabaseClient> {
    const client = await this.auth.sharedClient();
    if (!client) throw new Error('Accounts are not set up.');
    return client;
  }
}
