import { TestBed } from '@angular/core/testing';
import { AuthStore } from './auth.store';
import { AuthPort } from './ports';

const user = { id: 'u1', email: 'me@example.com' };

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
