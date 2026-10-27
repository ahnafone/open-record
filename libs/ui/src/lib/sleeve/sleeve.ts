import {
  ChangeDetectionStrategy,
  booleanAttribute,
  Component,
  computed,
  effect,
  input,
  linkedSignal,
  signal,
} from '@angular/core';
import { OrDisc } from '../disc/disc';

export type SleeveSize = 'thumb' | 'mini' | 'large' | 'booth';

/** A cover URL, or a promise of one (resolved art). */
export type SleeveSrc =
  | string
  | null
  | undefined
  | PromiseLike<string | null | undefined>;

function isPromiseLike(
  v: SleeveSrc,
): v is PromiseLike<string | null | undefined> {
  return typeof v === 'object' && v !== null && 'then' in v;
}

/**
 * A record shown as a physical object: an ivory-bordered sleeve with a disc
 * peeking out behind it. Cover art fills a square sleeve (`object-fit: cover`). Missing or failed art becomes a designed grooved-disc fallback with
 * an ivory centre label.
 *
 * Sizes: `thumb` (60px row sleeve), `mini` (44px mini-player frame, no disc),
 * `large` (Now Playing), `booth` (Browse hero stage). `large`/`booth` fill the
 * width of their container.
 */
@Component({
  selector: 'or-sleeve',
  imports: [OrDisc],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[class]': '"size-" + size()',
  },
  template: `
    @if (size() !== 'mini') {
      <or-disc
        class="disc"
        [label]="label()"
        [showLabel]="size() !== 'thumb'"
        [spinning]="playing()"
        [flat]="size() === 'thumb'"
      />
    }
    <div class="art">
      @if (showFallback()) {
        <span class="fallback" role="img" [attr.aria-label]="fallbackLabel()">
          @if (size() !== 'mini' && label()) {
            <span class="fallback-label" aria-hidden="true">{{ label() }}</span>
          }
        </span>
      } @else {
        <img
          [src]="currentSrc()"
          [alt]="alt()"
          decoding="async"
          [attr.loading]="lazy() ? 'lazy' : null"
          (error)="onError()"
        />
      }
    </div>
  `,
  styles: `
    :host {
      --or-groove: color-mix(
        in srgb,
        var(--color-surface) 65%,
        var(--color-vinyl)
      );
      position: relative;
      display: block;
      flex: none;
    }
    .art {
      position: relative;
      z-index: 2;
      background: var(--color-ivory);
      border-radius: var(--rounded-sleeve);
    }
    img {
      display: block;
      inline-size: 100%;
      block-size: 100%;
      object-fit: cover;
      background: var(--color-surface);
    }
    .fallback {
      position: relative;
      display: block;
      inline-size: 100%;
      block-size: 100%;
      border-radius: 2px;
      overflow: hidden;
      background: repeating-radial-gradient(
        circle at 50% 50%,
        var(--color-vinyl) 0 2px,
        var(--or-groove) 2px 3.5px
      );
    }
    .fallback-label {
      position: absolute;
      left: 50%;
      top: 50%;
      inline-size: 44%;
      aspect-ratio: 1;
      transform: translate(-50%, -50%);
      border-radius: 50%;
      background: var(--color-ivory);
      color: var(--color-ink);
      display: grid;
      place-items: center;
      overflow: hidden;
      font: 600 8px/1 var(--font-body);
      letter-spacing: 0.02em;
    }
    .disc {
      position: absolute;
      z-index: 1;
    }

    /* thumb: 60px sleeve with the disc peeking out to the right */
    :host(.size-thumb) {
      --s: 60px;
      /* Wide enough for the peeking disc (0.42s + 0.76s), since paint
         containment clips anything outside the box. */
      inline-size: calc(var(--s) * 1.18);
      block-size: var(--s);
      /* Rows hold many thumbs: keep each one's layout and paint to itself. */
      contain: layout paint;
    }
    :host(.size-thumb) .disc {
      inline-size: calc(var(--s) * 0.76);
      left: calc(var(--s) * 0.42);
      top: calc(var(--s) * 0.12);
    }
    :host(.size-thumb) .art {
      position: absolute;
      left: 0;
      top: 0;
      inline-size: var(--s);
      block-size: var(--s);
      padding: 3px;
      border-radius: 2px;
    }

    /* mini: 44px ivory frame in the mini player */
    :host(.size-mini) {
      inline-size: 44px;
      block-size: 44px;
    }
    :host(.size-mini) .art {
      inline-size: 100%;
      block-size: 100%;
      padding: 2px;
    }

    /* booth: Browse hero stage, sleeve overlapping a large disc */
    :host(.size-booth) {
      inline-size: 100%;
      /* As tall as the sleeve (68% of the width) so nothing is cropped. */
      aspect-ratio: 1 / 0.68;
    }
    :host(.size-booth) .disc {
      right: 0;
      top: 0;
      inline-size: 68%;
    }
    :host(.size-booth) .art {
      position: absolute;
      left: 0;
      top: 0;
      inline-size: 68%;
      aspect-ratio: 1;
      padding: 5px;
      box-shadow: 0 16px 30px
        color-mix(in srgb, var(--color-vinyl) 55%, transparent);
    }

    /* large: Now Playing, square sleeve */
    :host(.size-large) {
      inline-size: 100%;
      padding-right: 20%;
    }
    :host(.size-large) .disc {
      z-index: 0;
      right: 0;
      top: 9%;
      inline-size: 66%;
    }
    :host(.size-large) .art {
      z-index: 1;
      inline-size: 100%;
      aspect-ratio: 1;
      padding: 6px;
      box-shadow: 0 18px 34px
        color-mix(in srgb, var(--color-vinyl) 55%, transparent);
    }
  `,
})
export class OrSleeve {
  /**
   * Cover art URL, or a promise of one (art resolved at display time). Empty,
   * pending, rejected or failing to load shows the disc fallback.
   */
  readonly src = input<SleeveSrc>(null);
  readonly alt = input<string>('');
  /** Centre-label text (e.g. catalogue number) for the disc and fallback. */
  readonly label = input<string>('');
  /** Accessible name of the fallback artwork. */
  readonly fallbackLabel = input<string>('Sleeve artwork unavailable');
  readonly size = input<SleeveSize>('thumb');
  /** Spins the disc (stopped under reduced motion). */
  readonly playing = input(false, { transform: booleanAttribute });
  readonly lazy = input(true, { transform: booleanAttribute });

  private readonly failedSrc = signal<string | null>(null);

  /** Settled value of a promised `src`; reset whenever `src` changes. */
  private readonly resolvedSrc = linkedSignal<SleeveSrc, string | null>({
    source: this.src,
    computation: () => null,
  });

  protected readonly currentSrc = computed(() => {
    const src = this.src();
    return isPromiseLike(src) ? this.resolvedSrc() : (src ?? null);
  });

  protected readonly showFallback = computed(() => {
    const src = this.currentSrc();
    return !src || this.failedSrc() === src;
  });

  constructor() {
    effect((onCleanup) => {
      const src = this.src();
      if (!isPromiseLike(src)) return;
      let live = true;
      onCleanup(() => (live = false));
      src.then(
        (url) => live && this.resolvedSrc.set(url || null),
        () => undefined,
      );
    });
  }

  protected onError(): void {
    this.failedSrc.set(this.currentSrc());
  }
}
