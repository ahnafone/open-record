import { inject } from '@angular/core';
import { type CanActivateFn, Router } from '@angular/router';
import { AuthStore, WEB_BUILD } from '@open-record/state';

/**
 * Web build only: Library and Playlists need an account. A signed-out visitor
 * gets the sign-in prompt (which offers request access) and stays where they
 * are; a direct visit lands on Browse. Native and desktop always pass, and so
 * does a web build with no account service (nothing could sign in).
 *
 * This is a UX gate only, not a security boundary: library data is stored
 * locally on the device, so the pages are hidden behind the prompt rather than
 * protected. The guard opens when accounts are not configured or not ready
 * (`!accountsReady()`), so the app still works without a Supabase project.
 */
export const requireWebAccount: CanActivateFn = async () => {
  if (!inject(WEB_BUILD)) return true;
  const auth = inject(AuthStore);
  const router = inject(Router);
  await auth.start();
  if (auth.signedIn() || !auth.accountsReady()) return true;
  auth.promptSignIn('Sign in to open your library and playlists.');
  return router.navigated ? false : router.parseUrl('/browse');
};
