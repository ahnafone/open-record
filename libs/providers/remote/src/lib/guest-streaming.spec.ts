import { GuestHostError, GuestLimitError, RemoteBusyError, RemoteClient, type HttpTransport } from '../index';

function transport(status: number, data: unknown, headers: Record<string, string> = {}) {
  const auth: (string | undefined)[] = [];
  const t: HttpTransport & { auth: (string | undefined)[] } = {
    auth,
    async request(req) {
      auth.push(req.headers['Authorization']);
      return { status, headers: { 'content-type': 'application/json', ...headers }, data };
    },
  };
  return t;
}

describe('guest streaming (remote client)', () => {
  it('maps 429 error=guest_limit to GuestLimitError with the Retry-After hint', async () => {
    const client = new RemoteClient({ baseUrl: 'https://public.example' }, transport(429, { error: 'guest_limit' }, { 'retry-after': '30' }));

    const err = await client.streamUrl('https://www.youtube.com/watch?v=x').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GuestLimitError);
    expect((err as GuestLimitError).name).toBe('guest_limit');
    expect((err as GuestLimitError).retryAfterSec).toBe(30);
  });

  it('sends no Authorization header to a signed-out guest and does not prompt on 401 when guestStreaming is on', async () => {
    const t = transport(401, { error: 'unauthorized' });
    const onUnauthorized = vi.fn();
    const client = new RemoteClient({ baseUrl: 'https://public.example' }, t, {
      accessToken: async () => null,
      onUnauthorized,
      guestStreaming: () => true,
    });

    await expect(client.search('nina simone')).rejects.toMatchObject({ name: 'AuthError' });

    expect(t.auth).toEqual([undefined]);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('keeps the sign-in prompt for a signed-in user whose token refresh failed', async () => {
    const t = transport(401, {});
    const onUnauthorized = vi.fn();
    const onGuestRejected = vi.fn();
    const client = new RemoteClient({ baseUrl: 'https://public.example' }, t, {
      accessToken: async () => null,
      signedIn: () => true,
      onUnauthorized,
      onGuestRejected,
      guestStreaming: () => true,
    });

    await expect(client.search('nina simone')).rejects.toMatchObject({ name: 'AuthError' });

    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(onGuestRejected).not.toHaveBeenCalled();
  });

  it('reports a guest 401 to onGuestRejected instead of prompting', async () => {
    const onUnauthorized = vi.fn();
    const onGuestRejected = vi.fn();
    const client = new RemoteClient({ baseUrl: 'https://public.example' }, transport(401, {}), {
      accessToken: async () => null,
      signedIn: () => false,
      onUnauthorized,
      onGuestRejected,
      guestStreaming: () => true,
    });

    await expect(client.search('nina simone')).rejects.toMatchObject({ name: 'AuthError' });

    expect(onGuestRejected).toHaveBeenCalledTimes(1);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('does not re-read the guest flag on a guest 403 (only a 401 means it is stale)', async () => {
    const onGuestRejected = vi.fn();
    const client = new RemoteClient({ baseUrl: 'https://public.example' }, transport(403, {}), {
      accessToken: async () => null,
      onGuestRejected,
      guestStreaming: () => true,
    });

    await expect(client.search('nina simone')).rejects.toMatchObject({ name: 'AuthError' });

    expect(onGuestRejected).not.toHaveBeenCalled();
  });

  it('maps a guest 403 guest_host_not_allowed to GuestHostError with no prompt and no flag re-read', async () => {
    const onUnauthorized = vi.fn();
    const onGuestRejected = vi.fn();
    const client = new RemoteClient({ baseUrl: 'https://public.example' }, transport(403, { error: 'guest_host_not_allowed' }), {
      accessToken: async () => null,
      onUnauthorized,
      onGuestRejected,
      guestStreaming: () => true,
    });

    const err = await client.streamUrl('https://example.com/x', undefined, undefined, true).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GuestHostError);
    expect((err as GuestHostError).name).toBe('guest_host_not_allowed');
    expect(onGuestRejected).not.toHaveBeenCalled();
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('maps 503 guest_busy to a busy error carrying the guest code', async () => {
    const client = new RemoteClient({ baseUrl: 'https://public.example' }, transport(503, { error: 'guest_busy' }, { 'retry-after': '5' }), {
      accessToken: async () => null,
      guestStreaming: () => true,
    });

    const err = await client.streamUrl('https://www.youtube.com/watch?v=x', undefined, undefined, true).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RemoteBusyError);
    expect((err as RemoteBusyError).code).toBe('guest_busy');
    expect((err as RemoteBusyError).retryAfterSec).toBe(5);
  });

  it('treats a non-guest route as signed-out prompt, never a guest re-read, on a missing-token 401', async () => {
    const onUnauthorized = vi.fn();
    const onGuestRejected = vi.fn();
    const client = new RemoteClient({ baseUrl: 'https://public.example' }, transport(401, {}), {
      accessToken: async () => null,
      onUnauthorized,
      onGuestRejected,
      guestStreaming: () => true,
    });

    await expect(client.playlist('https://www.youtube.com/playlist?list=x')).rejects.toMatchObject({ name: 'AuthError' });

    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(onGuestRejected).not.toHaveBeenCalled();
  });

  it('does not treat a stream call without the guest option as a guest', async () => {
    const onUnauthorized = vi.fn();
    const onGuestRejected = vi.fn();
    const client = new RemoteClient({ baseUrl: 'https://public.example' }, transport(401, {}), {
      accessToken: async () => null,
      onUnauthorized,
      onGuestRejected,
      guestStreaming: () => true,
    });

    await expect(client.streamUrl('https://www.youtube.com/watch?v=x')).rejects.toMatchObject({ name: 'AuthError' });

    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(onGuestRejected).not.toHaveBeenCalled();
  });

  it('keeps the sign-in prompt for a guest when guestStreaming is off', async () => {
    const onUnauthorized = vi.fn();
    const client = new RemoteClient({ baseUrl: 'https://own.example' }, transport(401, {}), {
      accessToken: async () => null,
      onUnauthorized,
      guestStreaming: () => false,
    });

    await expect(client.search('nina simone')).rejects.toMatchObject({ name: 'AuthError' });

    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('reads guestStreaming from app-config (false when absent)', async () => {
    const on = new RemoteClient({ baseUrl: 'https://public.example' }, transport(200, { supabaseUrl: null, supabaseAnonKey: null, guestStreaming: true }));
    const off = new RemoteClient({ baseUrl: 'https://own.example' }, transport(200, { supabaseUrl: null, supabaseAnonKey: null }));

    await expect(on.appConfig()).resolves.toMatchObject({ guestStreaming: true });
    await expect(off.appConfig()).resolves.toMatchObject({ guestStreaming: false });
  });
});
