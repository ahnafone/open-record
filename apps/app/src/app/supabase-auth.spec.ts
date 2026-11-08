import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

describe('SupabaseAuth invite detection', () => {
  let emit: ((event: string, session: unknown) => void) | undefined;

  beforeEach(() => {
    createClient.mockReset();
    sessionStorage.clear();
    emit = undefined;
    createClient.mockImplementation(() => ({
      auth: {
        getSession: vi.fn(async () => ({ data: { session: null }, error: null })),
        onAuthStateChange: vi.fn((cb: (event: string, session: unknown) => void) => {
          emit = cb;
          return { data: { subscription: { unsubscribe: vi.fn() } } };
        }),
        stopAutoRefresh: vi.fn(async () => undefined),
      },
    }));
  });

  afterEach(() => {
    window.history.replaceState(null, '', '/');
  });

  /** Opens the app at `hash`, then the client reports a SIGNED_IN session with `accessToken`. */
  async function signInFrom(hash: string, accessToken: string) {
    window.history.replaceState(null, '', `/${hash}`);
    const auth = new SupabaseAuth(config);
    const recovery = vi.fn();
    auth.onRecovery(recovery);
    await auth.restore();
    emit?.('SIGNED_IN', { access_token: accessToken, user: { id: 'user-1', email: 'a@b.test' } });
    return recovery;
  }

  it('does not treat a bare forged #type=invite hash as an invite', async () => {
    const recovery = await signInFrom('#type=invite', 'attacker-token');
    expect(recovery).not.toHaveBeenCalled();
  });

  it('treats the SIGNED_IN session from a real invite link as an invite', async () => {
    const recovery = await signInFrom(
      '#type=invite&access_token=invite-token&refresh_token=refresh-token',
      'invite-token',
    );
    expect(recovery).toHaveBeenCalledTimes(1);
  });
});
