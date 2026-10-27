import {
  DestroyRef,
  Directive,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  linkedSignal,
  output,
  type Signal,
} from '@angular/core';

/** Rows rendered at first, and added each time the end comes near. */
export const LAZY_PAGE_SIZE = 40;
/** Cards rendered at first in a horizontal crate rail, and added per page. */
export const RAIL_PAGE_SIZE = 12;

export interface LazyWindow<T> {
  /** The first `limit` items of the source: what the template renders. */
  readonly items: Signal<readonly T[]>;
  /** More items exist past the rendered ones. */
  readonly hasMore: Signal<boolean>;
  /** Render another page. */
  grow(): void;
}

/**
 * Incremental rendering for long lists: render the first page of `source`
 * and grow a page at a time (see `OrLoadMore`). The window shrinks back to
 * one page whenever `resetOn` changes (a filter or sort), not when the
 * source merely updates, so saving or downloading a row keeps the scroll.
 * Play queues should keep using the full source, not `items`.
 */
export function lazyWindow<T>(
  source: () => readonly T[],
  resetOn: () => unknown = () => undefined,
  pageSize = LAZY_PAGE_SIZE,
): LazyWindow<T> {
  const limit = linkedSignal({
    source: resetOn,
    computation: () => pageSize,
  });
  return {
    items: computed(() => {
      const all = source();
      const n = limit();
      return all.length <= n ? all : all.slice(0, n);
    }),
    hasMore: computed(() => source().length > limit()),
    grow: () => limit.update((n) => n + pageSize),
  };
}

/**
 * Sentinel placed after a lazily rendered list: emits `loadMore` when it
 * comes within ~a screen of the viewport (inside any scrolling ancestor),
 * on either axis so horizontal rails preload too.
 * Bind `loadMoreKey` to the rendered count so the sentinel re-checks after
 * each page and keeps loading while it is still in view.
 */
@Directive({
  selector: '[orLoadMore]',
  host: { 'aria-hidden': 'true' },
})
export class OrLoadMore {
  readonly loadMoreKey = input<unknown>();
  readonly loadMore = output<void>();

  constructor() {
    const el = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    const injector = inject(Injector);
    const destroyRef = inject(DestroyRef);
    if (typeof IntersectionObserver === 'undefined') {
      // No observer (old engines, tests): keep loading until everything shows.
      let destroyed = false;
      destroyRef.onDestroy(() => (destroyed = true));
      effect(() => {
        this.loadMoreKey();
        queueMicrotask(() => destroyed || this.loadMore.emit());
      });
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) this.loadMore.emit();
      },
      // rootMargin only grows the viewport; scrollMargin grows each scrolling
      // ancestor's clip (a crate rail, the screen host) by the same amount,
      // so the sentinel fires before it reaches their edge. Engines without
      // scrollMargin ignore it and load once the sentinel is in view.
      { rootMargin: '800px 640px', scrollMargin: '800px 640px' },
    );
    effect((onCleanup) => {
      this.loadMoreKey();
      // Re-observe after the new rows render: observe() reports the current
      // state, so a sentinel still in view asks for the next page.
      const ref = afterNextRender(() => io.observe(el), { injector });
      onCleanup(() => {
        ref.destroy();
        io.unobserve(el);
      });
    });
    destroyRef.onDestroy(() => io.disconnect());
  }
}
