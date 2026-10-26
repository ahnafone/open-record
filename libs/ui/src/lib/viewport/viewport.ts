import { DOCUMENT, DestroyRef, Injectable, inject, signal } from '@angular/core';

/** Viewport width (px) from which the desktop layout applies. Keep in sync with CSS `@media (min-width: 900px)`. */
export const DESKTOP_MIN_WIDTH = 900;

/** Media query for the desktop layout. */
export const DESKTOP_MEDIA_QUERY = `(min-width: ${DESKTOP_MIN_WIDTH}px)`;

/**
 * App-wide viewport facts as signals. `isDesktop` is true at
 * `DESKTOP_MIN_WIDTH` and wider; phones (and SSR/tests without matchMedia)
 * get false, so the phone layout is the default.
 */
@Injectable({ providedIn: 'root' })
export class OrViewport {
  private readonly _isDesktop = signal(false);
  readonly isDesktop = this._isDesktop.asReadonly();

  constructor() {
    const win = inject(DOCUMENT).defaultView;
    const mql = win?.matchMedia?.(DESKTOP_MEDIA_QUERY);
    if (!mql) return;
    this._isDesktop.set(mql.matches);
    const onChange = (e: MediaQueryListEvent) => this._isDesktop.set(e.matches);
    mql.addEventListener?.('change', onChange);
    inject(DestroyRef).onDestroy(() =>
      mql.removeEventListener?.('change', onChange),
    );
  }
}
