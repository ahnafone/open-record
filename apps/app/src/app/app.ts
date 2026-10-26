import {
  ChangeDetectionStrategy,
  Component,
  DOCUMENT,
  DestroyRef,
  ElementRef,
  afterNextRender,
  type Type,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { Location, NgComponentOutlet } from '@angular/common';
import {
  ActivatedRouteSnapshot,
  NavigationEnd,
  Router,
  RouterOutlet,
} from '@angular/router';
import { filter, map } from 'rxjs';
import { AuthStore, LibraryStore, PlayerStore, PlaylistsStore } from '@open-record/state';
import { OrToastHost, OrViewport } from '@open-record/ui';
import type { ScreenData } from './app.routes';
import { OrMiniPlayer } from './shell/mini-player';
import { OrPlayerBar } from './shell/player-bar';
import { OrSidebar } from './shell/sidebar';
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

/** Screens whose content is capped to a readable width on desktop. */
const NARROW_SCREENS: ReadonlySet<string> = new Set(['settings', 'import']);

/**
 * App shell: top bar, scrolling screen host (`router-outlet`) and a dock with
 * the mini player and tab bar, laid out as a 3-row grid. Owns the toast host.
 * Confirm dialogs (`OrDialog`) attach to <body> themselves.
 *
 * Desktop (900px+, `OrViewport.isDesktop`): sidebar, content, an optional
 * Now Playing side panel and a full-width player bar; keyboard shortcuts.
 */
@Component({
  imports: [
    RouterOutlet,
    NgComponentOutlet,
    OrTopBar,
    OrMiniPlayer,
    OrTabBar,
    OrToastHost,
    OrSidebar,
    OrPlayerBar,
  ],
  selector: 'or-root',
  host: {
    '[class.desktop]': 'viewport.isDesktop()',
    '(document:keydown)': 'onKeydown($event)',
  },
  templateUrl: './app.html',
  styleUrl: './app.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {
  private readonly router = inject(Router);
  private readonly location = inject(Location);
  private readonly document = inject(DOCUMENT);
  protected readonly player = inject(PlayerStore);
  protected readonly viewport = inject(OrViewport);
  private readonly playlists = inject(PlaylistsStore);

  private readonly destroyRef = inject(DestroyRef);
  private readonly auth = inject(AuthStore);

  /** The "Sign in to continue" modal, loaded with the settings chunk on first use. */
  protected readonly signInPrompt = signal<Type<unknown> | null>(null);

  private readonly screenHost =
    viewChild<ElementRef<HTMLElement>>('screenHost');
  private readonly dock = viewChild.required<ElementRef<HTMLElement>>('dock');

  /** Desktop: the user opened the Now Playing side panel. */
  private readonly nowPlayingOpen = signal(false);
  /** Now Playing page component, loaded with its chunk when the panel first opens. */
  protected readonly nowPlayingPanel = signal<Type<unknown> | null>(null);

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

  protected readonly isDesktop = this.viewport.isDesktop;
  protected readonly onNowPlaying = computed(
    () => this.screen().data.screen === 'now-playing',
  );
  /** The side panel shows unless the full Now Playing page already does. */
  protected readonly panelShown = computed(
    () => this.isDesktop() && this.nowPlayingOpen() && !this.onNowPlaying(),
  );
  protected readonly narrow = computed(
    () => this.isDesktop() && NARROW_SCREENS.has(this.screen().data.screen),
  );

  constructor() {
    // Hydrate library and playlists at startup (PlayerStore also depends on them).
    inject(LibraryStore);

    effect(() => {
      if (!this.auth.signInPrompt() || this.signInPrompt()) return;
      void import('@open-record/features/settings').then((m) =>
        this.signInPrompt.set(m.OrSignInPrompt),
      );
    });

    // A password reset link signs the user in; take them to the new-password form.
    effect(() => {
      if (this.auth.recovering()) void this.router.navigateByUrl('/settings');
    });

    effect(() => {
      if (!this.panelShown() || this.nowPlayingPanel()) return;
      void import('@open-record/features/now-playing').then((m) =>
        this.nowPlayingPanel.set(m.NowPlayingPage),
      );
    });

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

  /** Player bar toggle: side panel, or leave the full Now Playing page. */
  protected toggleNowPlaying(): void {
    if (this.onNowPlaying()) {
      this.back();
      return;
    }
    this.nowPlayingOpen.update((open) => !open);
  }

  /** Desktop shortcuts; ignored while typing, in dialogs or with modifiers. */
  protected onKeydown(event: KeyboardEvent): void {
    if (!this.isDesktop() || event.defaultPrevented) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="dialog"], dialog')) {
      return;
    }
    const hasTrack = !!this.player.current();
    switch (event.key) {
      case ' ':
        // Space on a focused control activates that control instead.
        if (target?.closest('button, a, [role="slider"], [role="radio"], [role="checkbox"], summary')) return;
        if (!hasTrack) return;
        event.preventDefault();
        void this.player.togglePlay();
        return;
      case 'ArrowLeft':
      case 'ArrowRight': {
        if (target?.closest('[role="slider"], [role="radiogroup"], [role="tablist"]')) return;
        if (!hasTrack) return;
        event.preventDefault();
        const forward = event.key === 'ArrowRight';
        if (event.shiftKey) void (forward ? this.player.next() : this.player.previous());
        else void this.player.seekBy(forward ? 5 : -5);
        return;
      }
      case 'm':
      case 'M':
        if (!this.player.canSetVolume) return;
        event.preventDefault();
        this.player.toggleMute();
        return;
      case '/':
        event.preventDefault();
        void this.focusSearch();
        return;
    }
  }

  private async focusSearch(): Promise<void> {
    if (this.screen().data.screen !== 'search') {
      await this.router.navigateByUrl('/search');
    }
    // The search page renders after navigation: try for a few frames.
    for (let i = 0; i < 10; i++) {
      const input = this.document.getElementById('or-search-input');
      if (input) {
        input.focus();
        return;
      }
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
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
