import { inject } from '@angular/core';
import { type CanActivateFn, Router } from '@angular/router';
import { AuthStore } from '@open-record/state';

/**
 * `/admin` is only reachable for the server's admin (`AuthStore.isAdmin`).
 * Everyone else is sent to Browse. This is a UX gate only: the server and the
 * edge functions enforce admin rights on every access-request call.
 * It waits for the session restore and the admin probe, so a cold load
 * straight onto /admin works for the admin.
 */
export const adminGuard: CanActivateFn = async () => {
  const auth = inject(AuthStore);
  const router = inject(Router);
  try {
    await auth.start();
    await auth.whenAdminResolved();
  } catch {
    return router.parseUrl('/browse');
  }
  return auth.isAdmin() ? true : router.parseUrl('/browse');
};
