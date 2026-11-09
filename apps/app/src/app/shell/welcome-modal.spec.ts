import { signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { AuthStore, WEB_BUILD, type AuthStatus } from '@open-record/state';
import { OrWelcomeModal } from './welcome-modal';

const DISMISSED_KEY = 'or.welcome.dismissed';

function setup(opts: { web: boolean; status: AuthStatus }) {
  const status: WritableSignal<AuthStatus> = signal(opts.status);
  TestBed.configureTestingModule({
    providers: [
      { provide: WEB_BUILD, useValue: opts.web },
      { provide: AuthStore, useValue: { status } },
    ],
  });
  const fixture = TestBed.createComponent(OrWelcomeModal);
  fixture.detectChanges();
  return { fixture, status };
}

function closeX(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.modal .close');
}

describe('OrWelcomeModal', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('is not shown off the web build, even when signed out', async () => {
    const { fixture } = setup({ web: false, status: 'signedOut' });
    await fixture.whenStable();

    expect(fixture.componentInstance['open']()).toBe(false);
    expect(document.body.textContent).not.toContain('Welcome to Open Record');
  });

  it('is shown on the web build for a signed-out visitor', async () => {
    const { fixture } = setup({ web: true, status: 'signedOut' });
    await fixture.whenStable();

    expect(fixture.componentInstance['open']()).toBe(true);
    expect(document.body.textContent).toContain('Welcome to Open Record');
  });

  it('is hidden for a signed-in user', async () => {
    const { fixture } = setup({ web: true, status: 'signedIn' });
    await fixture.whenStable();

    expect(fixture.componentInstance['open']()).toBe(false);
    expect(document.body.textContent).not.toContain('Welcome to Open Record');
  });

  it('is hidden while the account restore is loading, then shows once signed out', async () => {
    const { fixture, status } = setup({ web: true, status: 'loading' });
    await fixture.whenStable();
    expect(fixture.componentInstance['open']()).toBe(false);

    status.set('signedOut');
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fixture.componentInstance['open']()).toBe(true);
  });

  it('is hidden once the dismissal is already remembered', async () => {
    localStorage.setItem(DISMISSED_KEY, '1');
    const { fixture } = setup({ web: true, status: 'signedOut' });
    await fixture.whenStable();

    expect(fixture.componentInstance['open']()).toBe(false);
  });

  it('remembers signing in, so signing out later does not show it', async () => {
    const { fixture, status } = setup({ web: true, status: 'signedIn' });
    await fixture.whenStable();
    expect(localStorage.getItem(DISMISSED_KEY)).toBe('1');

    status.set('signedOut');
    fixture.detectChanges();
    await fixture.whenStable();

    expect(fixture.componentInstance['open']()).toBe(false);
  });

  it('stays hidden after signing out in the same session when storage throws', async () => {
    const setItem = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new Error('blocked');
      });
    try {
      const { fixture, status } = setup({ web: true, status: 'signedIn' });
      await fixture.whenStable();

      status.set('signedOut');
      fixture.detectChanges();
      await fixture.whenStable();

      expect(fixture.componentInstance['open']()).toBe(false);
    } finally {
      setItem.mockRestore();
    }
  });

  it('persists the dismissal when Escape closes it', async () => {
    const { fixture } = setup({ web: true, status: 'signedOut' });
    await fixture.whenStable();

    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    fixture.detectChanges();

    expect(fixture.componentInstance['open']()).toBe(false);
    expect(localStorage.getItem(DISMISSED_KEY)).toBe('1');
  });

  it('persists the dismissal when the X closes it', async () => {
    const { fixture } = setup({ web: true, status: 'signedOut' });
    await fixture.whenStable();

    const x = closeX();
    expect(x).not.toBeNull();
    x?.click();
    fixture.detectChanges();

    expect(fixture.componentInstance['open']()).toBe(false);
    expect(localStorage.getItem(DISMISSED_KEY)).toBe('1');
  });

  it('offers Download App, GitHub and Official Site as external links', async () => {
    const { fixture } = setup({ web: true, status: 'signedOut' });
    await fixture.whenStable();

    const links = Array.from(
      document.querySelectorAll<HTMLAnchorElement>('.modal a.btn'),
    );
    expect(links.map((a) => a.textContent?.trim())).toEqual([
      'Download App',
      'GitHub',
      'Official Site',
    ]);
    for (const a of links) {
      expect(a.target).toBe('_blank');
      expect(a.rel).toBe('noopener noreferrer');
    }
  });

  it('remembers the dismissal from "Get started"', async () => {
    const { fixture } = setup({ web: true, status: 'signedOut' });
    await fixture.whenStable();

    const getStarted = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.modal button.ghost'),
    ).find((b) => b.textContent?.trim() === 'Get started');
    getStarted?.click();
    fixture.detectChanges();

    expect(fixture.componentInstance['open']()).toBe(false);
    expect(localStorage.getItem(DISMISSED_KEY)).toBe('1');
  });
});
