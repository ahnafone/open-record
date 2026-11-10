import { TestBed } from '@angular/core/testing';
import { AUTH_ACCESS_RECHECK, AuthStore } from './auth.store';
import { AuthPort } from './ports';

const user = { id: 'u1', email: 'me@example.com' };

afterEach(() => {
  vi.restoreAllMocks();
});

function setup() {
  let recover!: () => void;
  const calls: string[] = [];
  const port = {
    activeProject: async () => ({ url: 'https://x.supabase.co', anonKey: 'anon' }),
    restore: async () => user,
    onChange: () => () => undefined,
    onRecovery: (listener: () => void) => {
      recover = listener;
      return () => undefined;
    },
    verifyPassword: vi.fn(async (pw: string) => {
      calls.push('verify');
      if (pw !== 'old-secret') throw new Error('Current password is incorrect.');
    }),
    updatePassword: vi.fn(async () => {
      calls.push('update');
    }),
  } as unknown as AuthPort;
  TestBed.configureTestingModule({ providers: [{ provide: AuthPort, useValue: port }] });
  return { store: TestBed.inject(AuthStore), port, calls, recover: () => recover() };
}

describe('AuthStore admin probe on an own server', () => {
  it('probes the project functions URL when the public server is off', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{"requests":[]}', { status: 200 }));
    const port = {
      activeProject: async () => ({ url: 'https://own.example.co/', anonKey: 'anon' }),
      accessToken: async () => 'token',
      restore: async () => user,
      onChange: () => () => undefined,
      onRecovery: () => () => undefined,
    } as unknown as AuthPort;
    TestBed.configureTestingModule({ providers: [{ provide: AuthPort, useValue: port }] });
    const store = TestBed.inject(AuthStore);
    await store.start();
    await store.whenAdminResolved();

    expect(store.publicServer()).toBe(false);
    expect(store.isAdmin()).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe('https://own.example.co/functions/v1/list-access');
  });

  it('is not admin when the server answers 403', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"error":"access-not-approved"}', { status: 403 }),
    );
    const port = {
      activeProject: async () => ({ url: 'https://own.example.co', anonKey: 'anon' }),
      accessToken: async () => 'token',
      restore: async () => user,
      onChange: () => () => undefined,
      onRecovery: () => () => undefined,
    } as unknown as AuthPort;
    TestBed.configureTestingModule({ providers: [{ provide: AuthPort, useValue: port }] });
    const store = TestBed.inject(AuthStore);
    await store.start();
    await store.whenAdminResolved();

    expect(store.isAdmin()).toBe(false);
  });
});

describe('AuthStore access recheck', () => {
  it('clears a denial only when the server accepts the check', async () => {
    const port = {
      activeProject: async () => ({ url: 'https://own.example.co', anonKey: 'anon' }),
      accessToken: async () => null,
      restore: async () => user,
      onChange: () => () => undefined,
      onRecovery: () => () => undefined,
    } as unknown as AuthPort;
    const check = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    TestBed.configureTestingModule({
      providers: [
        { provide: AuthPort, useValue: port },
        { provide: AUTH_ACCESS_RECHECK, useValue: check },
      ],
    });
    const store = TestBed.inject(AuthStore);
    await store.start();
    store.markAccessDenied();
    expect(store.accessDenied()).toBe(true);

    expect(await store.recheckAccess()).toBe(false);
    expect(store.accessDenied()).toBe(true);

    expect(await store.recheckAccess()).toBe(true);
    expect(store.accessDenied()).toBe(false);
    expect(check).toHaveBeenCalledTimes(2);
  });
});

describe('AuthStore password changes', () => {
  it('refuses the no-current-password path unless recovering from a reset link', async () => {
    const { store, port, recover } = setup();
    await store.start();
    expect(await store.setNewPassword('new-secret')).toBe(false);
    expect(port.updatePassword).not.toHaveBeenCalled();

    recover();
    expect(await store.setNewPassword('new-secret')).toBe(true);
    expect(port.updatePassword).toHaveBeenCalledWith('new-secret');
    expect(store.recovering()).toBe(false);
  });

  it('verifies the current password before updating, and never updates on a wrong one', async () => {
    const { store, port, calls } = setup();
    await store.start();
    expect(await store.changePassword('wrong', 'new-secret')).toBe(false);
    expect(store.error()).toBe('Current password is incorrect.');
    expect(port.updatePassword).not.toHaveBeenCalled();

    expect(await store.changePassword('old-secret', 'old-secret')).toBe(false);
    expect(await store.changePassword('old-secret', 'new-secret')).toBe(true);
    expect(calls).toEqual(['verify', 'verify', 'update']);
  });
});
