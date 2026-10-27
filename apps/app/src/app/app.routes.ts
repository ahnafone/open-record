import { inject } from '@angular/core';
import { type CanActivateFn, Route, Router } from '@angular/router';
import { AuthStore } from '@open-record/state';

/** Import is account-only: signed out, open the sign-in prompt and stay put. */
const requireAccount: CanActivateFn = async () => {
  const auth = inject(AuthStore);
  const router = inject(Router);
  await auth.start();
  if (auth.requireAccount('Sign in to import your Spotify library.')) return true;
  // A direct visit has no page to stay on; land on the library instead.
  return router.navigated ? false : router.parseUrl('/library');
};

/** Which shell chrome a route uses. `root` screens are the three tabs. */
export interface ScreenData {
  screen:
    | 'browse'
    | 'search'
    | 'library'
    | 'playlist'
    | 'now-playing'
    | 'settings'
    | 'account'
    | 'import';
  root: boolean;
  /** Top-bar title for non-root screens (the playlist screen uses its name). */
  title?: string;
}

export const appRoutes: Route[] = [
  { path: '', pathMatch: 'full', redirectTo: 'browse' },
  {
    path: 'browse',
    title: 'Browse · Open Record',
    data: { screen: 'browse', root: true } satisfies ScreenData,
    loadComponent: () =>
      import('@open-record/features/browse').then((m) => m.BrowsePage),
  },
  {
    path: 'search',
    title: 'Search · Open Record',
    data: { screen: 'search', root: true } satisfies ScreenData,
    loadComponent: () =>
      import('@open-record/features/search').then((m) => m.SearchPage),
  },
  {
    path: 'library',
    title: 'Library · Open Record',
    data: { screen: 'library', root: true } satisfies ScreenData,
    loadComponent: () =>
      import('@open-record/features/library').then((m) => m.LibraryPage),
  },
  {
    path: 'playlist/:id',
    title: 'Playlist · Open Record',
    data: {
      screen: 'playlist',
      root: false,
      title: 'Playlist',
    } satisfies ScreenData,
    loadComponent: () =>
      import('@open-record/features/playlist').then((m) => m.PlaylistPage),
  },
  {
    path: 'now-playing',
    title: 'Now playing · Open Record',
    data: {
      screen: 'now-playing',
      root: false,
      title: 'Now playing',
    } satisfies ScreenData,
    loadComponent: () =>
      import('@open-record/features/now-playing').then((m) => m.NowPlayingPage),
  },
  {
    path: 'settings',
    title: 'Settings · Open Record',
    data: {
      screen: 'settings',
      root: false,
      title: 'Settings',
    } satisfies ScreenData,
    loadComponent: () =>
      import('@open-record/features/settings').then((m) => m.SettingsPage),
  },
  {
    path: 'account',
    title: 'Account · Open Record',
    data: {
      screen: 'account',
      root: false,
      title: 'Account',
    } satisfies ScreenData,
    loadComponent: () =>
      import('@open-record/features/account').then((m) => m.AccountPage),
  },
  {
    path: 'import/sessions',
    title: 'Import history · Open Record',
    data: {
      screen: 'import',
      root: false,
      title: 'Import history',
    } satisfies ScreenData,
    loadComponent: () =>
      import('@open-record/features/settings').then(
        (m) => m.ImportSessionsPage,
      ),
  },
  {
    path: 'import/sessions/:id',
    title: 'Import session · Open Record',
    data: {
      screen: 'import',
      root: false,
      title: 'Import session',
    } satisfies ScreenData,
    loadComponent: () =>
      import('@open-record/features/settings').then((m) => m.ImportSessionPage),
  },
  {
    path: 'downloads/failed',
    title: 'Fix failed downloads · Open Record',
    data: {
      screen: 'settings',
      root: false,
      title: 'Fix failed downloads',
    } satisfies ScreenData,
    loadComponent: () =>
      import('@open-record/features/import').then((m) => m.FailedDownloadsPage),
  },
  {
    path: 'import',
    title: 'Import playlists & files · Open Record',
    data: {
      screen: 'import',
      root: false,
      title: 'Import playlists & files',
    } satisfies ScreenData,
    canActivate: [requireAccount],
    loadComponent: () =>
      import('@open-record/features/import').then((m) => m.ImportPage),
  },
  { path: '**', redirectTo: 'browse' },
];
