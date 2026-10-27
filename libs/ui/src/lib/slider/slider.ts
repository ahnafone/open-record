import {
  ChangeDetectionStrategy,
  booleanAttribute,
  Component,
  ElementRef,
  computed,
  inject,
  input,
  model,
  output,
  signal,
} from '@angular/core';

/**
 * Seek slider (`role="slider"`): 44px tall hit area, 4px track with a coral
 * fill and a 16px coral thumb ringed in the background colour.
 *
 * - `[(value)]` updates continuously while dragging or on each key press.
 * - `(committed)` fires once per keyboard step and on pointer release: seek there.
 *
 * Keys: Arrow Left/Down and Right/Up move by `step`, PageDown/PageUp by
 * `largeStep` (default 10% of the range), Home/End jump to min/max.
 */
@Component({
  selector: 'or-slider',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    role: 'slider',
    'aria-orientation': 'horizontal',
    '[attr.tabindex]': 'disabled() ? -1 : 0',
    '[attr.aria-label]': 'label()',
    '[attr.aria-valuemin]': 'min()',
    '[attr.aria-valuemax]': 'max()',
    '[attr.aria-valuenow]': 'clamped()',
    '[attr.aria-valuetext]': 'valueText() || null',
    '[attr.aria-disabled]': 'disabled() ? "true" : null',
    '[class.is-dragging]': 'dragging()',
    '(keydown)': 'onKeydown($event)',
    '(pointerdown)': 'onPointerDown($event)',
    '(pointermove)': 'onPointerMove($event)',
    '(pointerup)': 'onPointerUp($event)',
    '(pointercancel)': 'onPointerUp($event)',
  },
  template: `
    <span class="track"
      ><span class="fill" [style.transform]="fillTransform()"></span
    ></span>
    <span class="thumb-rail"
      ><span class="thumb-pos" [style.transform]="thumbTransform()"
        ><span class="thumb"></span></span
    ></span>
  `,
  styles: `
    :host {
      --or-thumb: 16px;
      position: relative;
      display: block;
      inline-size: 100%;
      block-size: var(--spacing-touch);
      cursor: pointer;
      touch-action: none;
      user-select: none;
      border-radius: var(--rounded-md);
    }
    :host:focus-visible {
      outline: 2px solid var(--color-primary);
      outline-offset: 2px;
    }
    :host([aria-disabled='true']) {
      opacity: 0.45;
      cursor: not-allowed;
    }
    .track {
      position: absolute;
      left: 0;
      right: 0;
      top: 50%;
      block-size: 4px;
      margin-top: -2px;
      border-radius: 2px;
      overflow: hidden;
      background: color-mix(in srgb, var(--color-border) 70%, transparent);
    }
    /* Fill and thumb move by transform only: no layout per tick or drag. */
    .fill {
      display: block;
      block-size: 100%;
      inline-size: 100%;
      background: var(--color-primary);
      transform-origin: left center;
    }
    /* Clips the travelling box below so it never widens the scroll area. */
    .thumb-rail {
      position: absolute;
      inset: 0;
      overflow: hidden;
      pointer-events: none;
    }
    /* As wide as the thumb's travel, so translateX(100%) is the far end. */
    .thumb-pos {
      position: absolute;
      top: 0;
      bottom: 0;
      left: 0;
      inline-size: calc(100% - var(--or-thumb));
    }
    .thumb {
      position: absolute;
      left: 0;
      top: 50%;
      inline-size: var(--or-thumb);
      block-size: var(--or-thumb);
      margin-top: calc(var(--or-thumb) / -2);
      border-radius: 50%;
      background: var(--color-primary);
      border: 2px solid var(--color-background);
      box-sizing: border-box;
    }
  `,
})
export class OrSlider {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly value = model<number>(0);
  readonly min = input<number>(0);
  readonly max = input<number>(100);
  readonly step = input<number>(1);
  /** PageUp/PageDown increment. Defaults to 10% of the range. */
  readonly largeStep = input<number | null>(null);
  readonly disabled = input(false, { transform: booleanAttribute });
  /** Accessible name (required). */
  readonly label = input.required<string>();
  /** Human readable value, e.g. "1:23 of 4:56". */
  readonly valueText = input<string>('');

  /** Fired when the user settles on a value (key press, pointer release). */
  readonly committed = output<number>();

  protected readonly dragging = signal(false);

  protected readonly clamped = computed(() => this.clamp(this.value()));

  /** 0..1 position of the value in the range. */
  private readonly ratio = computed(() => {
    const span = this.max() - this.min();
    if (!(span > 0)) return 0;
    return (this.clamped() - this.min()) / span;
  });

  protected readonly fillTransform = computed(() => `scaleX(${this.ratio()})`);

  /** Keeps the whole thumb inside the track at both ends. */
  protected readonly thumbTransform = computed(
    () => `translateX(${this.ratio() * 100}%)`,
  );

  /** Host rect, measured once per drag (not on every pointermove). */
  private rect: DOMRect | null = null;

  protected onKeydown(event: KeyboardEvent): void {
    if (this.disabled()) return;
    const min = this.min();
    const max = this.max();
    const step = this.step() > 0 ? this.step() : 1;
    const large = this.largeStep() ?? Math.max(step, (max - min) / 10);
    const current = this.clamped();
    let next: number;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowUp':
        next = current + step;
        break;
      case 'ArrowLeft':
      case 'ArrowDown':
        next = current - step;
        break;
      case 'PageUp':
        next = current + large;
        break;
      case 'PageDown':
        next = current - large;
        break;
      case 'Home':
        next = min;
        break;
      case 'End':
        next = max;
        break;
      default:
        return;
    }
    event.preventDefault();
    next = this.round(this.clamp(next));
    this.value.set(next);
    this.committed.emit(next);
  }

  protected onPointerDown(event: PointerEvent): void {
    if (
      this.disabled() ||
      (event.pointerType === 'mouse' && event.button !== 0)
    )
      return;
    const el = this.host.nativeElement;
    el.focus();
    try {
      el.setPointerCapture(event.pointerId);
    } catch {
      /* capture is best effort */
    }
    this.dragging.set(true);
    event.preventDefault();
    this.rect = el.getBoundingClientRect();
    this.setFromPointer(event.clientX);
  }

  protected onPointerMove(event: PointerEvent): void {
    if (!this.dragging()) return;
    this.setFromPointer(event.clientX);
  }

  protected onPointerUp(event: PointerEvent): void {
    if (!this.dragging()) return;
    this.dragging.set(false);
    this.rect = null;
    try {
      this.host.nativeElement.releasePointerCapture(event.pointerId);
    } catch {
      /* already released */
    }
    if (event.type === 'pointerup') this.committed.emit(this.clamped());
  }

  private setFromPointer(clientX: number): void {
    const rect = (this.rect ??= this.host.nativeElement.getBoundingClientRect());
    const thumb = 16;
    const usable = rect.width - thumb;
    if (!(usable > 0)) return;
    const ratio = Math.min(
      1,
      Math.max(0, (clientX - rect.left - thumb / 2) / usable),
    );
    const min = this.min();
    const raw = min + ratio * (this.max() - min);
    const step = this.step() > 0 ? this.step() : 1;
    const snapped = this.round(
      this.clamp(min + Math.round((raw - min) / step) * step),
    );
    if (snapped !== this.value()) this.value.set(snapped);
  }

  private clamp(v: number): number {
    const min = this.min();
    const max = Math.max(min, this.max());
    if (!Number.isFinite(v)) return min;
    return Math.min(max, Math.max(min, v));
  }

  private round(v: number): number {
    return Number(v.toFixed(6));
  }
}
