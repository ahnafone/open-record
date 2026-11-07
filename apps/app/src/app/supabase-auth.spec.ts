import { beforeEach, describe, expect, it, vi } from 'vitest';

const createClient = vi.hoisted(() => vi.fn());
vi.mock('@supabase/supabase-js', () => ({ createClient }));

import { SupabaseAuth } from './supabase-auth';

const config = { url: 'https://project.supabase.test', anonKey: 'anon-key' };

function fakeClient() {
  return {
    auth: {
      getSession: vi.fn(async () => ({ data: { session: null }, error: null })),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
      stopAutoRefresh: vi.fn(async () => undefined),
    },
  };
}

describe('SupabaseAuth client build', () => {
  beforeEach(() => {
    createClient.mockReset();
    sessionStorage.clear();
  });

  it('retries after a failed build instead of replaying the failure', async () => {
    createClient
      .mockImplementationOnce(() => {
        throw new Error('load failed');
      })
      .mockImplementation(() => fakeClient());
    const auth = new SupabaseAuth(config);

    await expect(auth.restore()).rejects.toThrow('load failed');
    await expect(auth.restore()).resolves.toBeNull();
    expect(createClient).toHaveBeenCalledTimes(2);
  });

  it('shares one build between concurrent callers for the same project', async () => {
    createClient.mockImplementation(() => fakeClient());
    const auth = new SupabaseAuth(config);

    await Promise.all([auth.restore(), auth.restore(), auth.restore()]);
    expect(createClient).toHaveBeenCalledTimes(1);
  });
});
