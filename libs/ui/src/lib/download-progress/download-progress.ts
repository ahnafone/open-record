import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';

/**
 * Live download progress under an auto-download switch: "Downloading · N
 * left", "X of Y on device" and a 4px coral bar (`role="progressbar"`). The
 * parent shows it only while something is downloading.
 */
@Component({
  selector: 'or-download-progress',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <p class="text">
      <span>Downloading · {{ left() }} left</span>
      <span class="count">{{ saved() }} of {{ total() }} on device</span>
    </p>
    <div
      class="bar"
      role="progressbar"
      [attr.aria-label]="label()"
      aria-valuemin="0"
      aria-valuemax="100"
      [attr.aria-valuenow]="percent()"
      [attr.aria-valuetext]="saved() + ' of ' + total() + ' on device'"
    >
      <span class="fill" [style.width.%]="percent()"></span>
    </div>
  `,
  styles: `
    :host {
      display: grid;
      gap: var(--spacing-xs);
      padding-block: var(--spacing-xs);
    }
    .text {
      display: flex;
      justify-content: space-between;
      gap: var(--spacing-sm);
      margin: 0;
      font-size: 12px;
      line-height: 1.4;
      color: var(--color-muted);
    }
    .count {
      font-variant-numeric: tabular-nums;
    }
    .bar {
      block-size: 4px;
      border-radius: 2px;
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
export class OrDownloadProgress {
  /** Tracks already on the device. */
  readonly saved = input(0);
  /** Tracks in the batch. */
  readonly total = input(0);
  /**
   * 0-1 overall progress, including partial downloads. Pass a signal (or
   * other reactive getter) so only this bar re-renders on progress ticks,
   * not the parent page.
   */
  readonly fraction = input<number | (() => number)>(0);
  readonly label = input('Download progress');

  protected readonly left = computed(() =>
    Math.max(0, this.total() - this.saved()),
  );
  protected readonly percent = computed(() => {
    const value = this.fraction();
    const f = typeof value === 'function' ? value() : value;
    return Number.isFinite(f) ? Math.round(Math.min(1, Math.max(0, f)) * 100) : 0;
  });
}
