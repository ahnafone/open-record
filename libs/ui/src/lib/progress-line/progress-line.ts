import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';

/**
 * 2px coral progress line (mini player top edge). Decorative: the seek slider
 * carries the accessible value.
 */
@Component({
  selector: 'or-progress-line',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    'aria-hidden': 'true',
  },
  template: `<span class="fill" [style.transform]="fill()"></span>`,
  styles: `
    :host {
      display: block;
      block-size: 2px;
      background: color-mix(in srgb, var(--color-border) 50%, transparent);
      overflow: hidden;
    }
    /* Scaled, not resized: a compositor-only change on every tick. */
    .fill {
      display: block;
      block-size: 100%;
      inline-size: 100%;
      background: var(--color-primary);
      transform-origin: left center;
      will-change: transform;
      transition: transform var(--duration-base) linear;
    }
    @media (prefers-reduced-motion: reduce) {
      .fill {
        transition-duration: 1ms;
      }
    }
  `,
})
export class OrProgressLine {
  readonly value = input<number>(0);
  readonly max = input<number>(1);

  /** `scaleX(0..1)` for the fill. */
  protected readonly fill = computed(() => {
    const max = this.max();
    const value = this.value();
    const f =
      max > 0 && Number.isFinite(value) ? Math.min(1, Math.max(0, value / max)) : 0;
    return `scaleX(${f})`;
  });
}
