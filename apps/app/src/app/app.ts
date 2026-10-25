import {
  ChangeDetectionStrategy,
  Component,
  DOCUMENT,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
  inject,
  viewChild,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { Location } from '@angular/common';
import {
  ActivatedRouteSnapshot,
  NavigationEnd,
  Router,
  RouterOutlet,
} from '@angular/router';
import { filter, map } from 'rxjs';
import { LibraryStore, PlayerStore, PlaylistsStore } from '@open-record/state';
import { OrToastHost } from '@open-record/ui';
import type { ScreenData } from './app.routes';
import { OrMiniPlayer } from './shell/mini-player';
import { OrTabBar } from './shell/tab-bar';
import { OrTopBar } from './shell/top-bar';

interface ScreenState {
  readonly data: ScreenData;
  readonly params: Record<string, string>;
}

const DEFAULT_SCREEN: ScreenState = {
  data: { screen: 'browse', root: true },
  params: {},
};

/**
 * App shell: top bar, scrolling screen host (`router-outlet`) and a dock with
 * the mini player and tab bar, laid out as a 3-row grid. Owns the toast host.
 * Confirm dialogs (`OrDialog`) attach to <body> themselves.
 */
@Component({
  imports: [RouterOutlet, OrTopBar, OrMiniPlayer, OrTabBar, OrToastHost],
  selector: 'or-root',
  templateUrl: './app.html',
  styleUrl: './app.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {
  private readonly router = inject(Router);
  private readonly location = inject(Location);
  private readonly document = inject(DOCUMENT);
  protected readonly player = inject(PlayerStore);
  private readonly playlists = inject(PlaylistsStore);

  private readonly destroyRef = inject(DestroyRef);

  private readonly screenHost =
    viewChild<ElementRef<HTMLElement>>('screenHost');
  private readonly dock = viewChild.required<ElementRef<HTMLElement>>('dock');

  protected readonly screen = toSignal(
    this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      map(() => {
        const host = this.screenHost()?.nativeElement;
        if (host) host.scrollTop = 0;
        return readScreen(this.router.routerState.snapshot.root);
      }),
    ),
    { initialValue: DEFAULT_SCREEN },
  );

  protected readonly title = computed(() => {
    const { data, params } = this.screen();
    if (data.screen === 'playlist') {
      return this.playlists.playlist(params['id'] ?? '')?.name ?? 'Playlist';
    }
    return data.title ?? '';
  });

  constructor() {
    // Hydrate library and playlists at startup (PlayerStore also depends on them).
    inject(LibraryStore);

    // Keep the toast above the dock, whatever its height.
    afterNextRender(() => {
      const dock = this.dock().nativeElement;
      const root = this.document.documentElement;
      const sync = () =>
        root.style.setProperty(
          '--or-toast-bottom',
          `${dock.getBoundingClientRect().height + 14}px`,
        );
      sync();
      if (typeof ResizeObserver === 'undefined') return;
      const observer = new ResizeObserver(sync);
      observer.observe(dock);
      this.destroyRef.onDestroy(() => observer.disconnect());
    });
  }

  protected openNowPlaying(): void {
    void this.router.navigateByUrl('/now-playing');
  }

  protected back(): void {
    // The router stamps each history entry with its navigationId; the app's
    // first entry is 1, so anything later has an in-app entry behind it.
    const state = this.location.getState() as { navigationId?: number } | null;
    if ((state?.navigationId ?? 1) > 1) this.location.back();
    else void this.router.navigateByUrl('/browse', { replaceUrl: true });
  }
}

function readScreen(root: ActivatedRouteSnapshot): ScreenState {
  let route = root;
  while (route.firstChild) route = route.firstChild;
  const data = route.data as Partial<ScreenData>;
  return data.screen
    ? { data: data as ScreenData, params: route.params }
    : DEFAULT_SCREEN;
}
