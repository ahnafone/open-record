import { Route } from '@angular/router';

/** Which shell chrome a route uses. `root` screens are the three tabs. */
export interface ScreenData {
  screen:
    | 'browse'
    | 'search'
    | 'library'
    | 'playlist'
    | 'now-playing'
    | 'settings';
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
  { path: '**', redirectTo: 'browse' },
];
