import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { AuthStatus } from '@open-record/state';
import { linkStripShown, linkStripVisibility } from './link-strip';

describe('linkStripShown', () => {
  it.each<[webBuild: boolean, status: AuthStatus, resolved: boolean, shown: boolean]>([
    [false, 'signedOut', true, false],
    [false, 'unconfigured', true, false],
    [false, 'loading', false, false],
    [true, 'loading', false, false],
    [true, 'loading', true, true],
    [true, 'signedIn', true, false],
    [true, 'signedOut', true, true],
    [true, 'unconfigured', true, true],
    [true, 'unavailable', true, true],
  ])(
    'webBuild=%s status=%s resolved=%s -> shown=%s',
    (webBuild, status, resolved, shown) => {
      expect(linkStripShown(webBuild, status, resolved)).toBe(shown);
    },
  );
});

describe('linkStripVisibility', () => {
  it('stays shown through a later loading status once it has resolved', () => {
    const status = signal<AuthStatus>('loading');
    const shown = TestBed.runInInjectionContext(() =>
      linkStripVisibility(true, status),
    );

    expect(shown()).toBe(false);

    status.set('signedOut');
    expect(shown()).toBe(true);

    status.set('loading');
    expect(shown()).toBe(true);
  });

  it('hides for a signed-in user and never shows off the web build', () => {
    const status = signal<AuthStatus>('signedOut');
    const web = TestBed.runInInjectionContext(() =>
      linkStripVisibility(true, status),
    );
    const native = TestBed.runInInjectionContext(() =>
      linkStripVisibility(false, status),
    );

    expect(web()).toBe(true);
    expect(native()).toBe(false);

    status.set('signedIn');
    expect(web()).toBe(false);
  });
});
