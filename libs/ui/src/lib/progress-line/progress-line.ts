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
  template: `<span class="fill" [style.width.%]="percent()"></span>`,
  styles: `
    :host {
      display: block;
      block-size: 2px;
      background: color-mix(in srgb, var(--color-border) 50%, transparent);
      overflow: hidden;
    }
    .fill {
      display: block;
      block-size: 100%;
      inline-size: 0;
      background: var(--color-primary);
      transition: width var(--duration-base) linear;
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

  protected readonly percent = computed(() => {
    const max = this.max();
    if (!(max > 0) || !Number.isFinite(this.value())) return 0;
    return Math.min(100, Math.max(0, (this.value() / max) * 100));
  });
}
