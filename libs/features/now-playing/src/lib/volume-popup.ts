import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { SessionStore } from '@open-record/state';
import { OrIcon, OrSlider } from '@open-record/ui';
import { DevicePickerService } from './device-picker';

/** The popup stays this long after the last activity or interaction. */
export const VOLUME_POPUP_HIDE_MS = 2000;

/** Debounce for remote-volume pushes while the thumb is moving. */
const VOLUME_PUSH_DEBOUNCE_MS = 200;
/**
 * After a committed push the thumb keeps the user's level this long, so a
 * stale remote echo cannot snap it back before the server has applied it.
 */
const VOLUME_COMMIT_HOLD_MS = 300;

/**
 * Transient volume popup for a remote session (another device or Cast owns
 * playback). Appears on every remote volume change, stays while the pointer
 * is over it or the thumb is dragged, and fades out 2s after the last
 * activity. Mounted once by the app shell; positioned above the dock.
 */
@Component({
  selector: 'or-volume-popup',
  imports: [OrIcon, OrSlider],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[class.shown]': 'shown()',
    '(pointerenter)': 'onPointerEnter()',
    '(pointerleave)': 'onPointerLeave()',
    '(pointerdown)': 'onPointerDown()',
    '(pointerup)': 'onPointerUp()',
    '(pointercancel)': 'onPointerUp()',
    '(focusin)': 'onFocusIn()',
    '(focusout)': 'onFocusOut($event)',
  },
  template: `
    <div class="panel" role="group" aria-label="Remote volume">
      <or-icon
        class="icon"
        [name]="sliderValue() === 0 ? 'volume-off' : 'volume'"
        [size]="20"
      />
      <or-slider
        class="slider"
        [label]="
          controllable() ? 'Remote volume' : 'Remote volume, set on the device'
        "
        [min]="0"
        [max]="100"
        [step]="1"
        [largeStep]="10"
        [disabled]="!controllable()"
        [value]="sliderValue()"
        [valueText]="valueText()"
        (valueChange)="onValueChange($event)"
        (committed)="commit()"
      />
      <span class="value" aria-live="polite">{{ valueText() }}</span>
      @if (!controllable()) {
        <span class="hint">Volume is set on the device</span>
      }
    </div>
  `,
  styles: `
    :host {
      position: absolute;
      bottom: 100%;
      inset-inline-end: var(--spacing-md);
      z-index: 20;
      margin-block-end: var(--spacing-sm);
      visibility: hidden;
      opacity: 0;
      pointer-events: none;
      transform: translateY(8px);
      transition:
        opacity var(--duration-fast) var(--ease-standard),
        transform var(--duration-fast) var(--ease-standard),
        visibility 0s linear var(--duration-fast);
    }
    :host(.shown) {
      visibility: visible;
      opacity: 1;
      pointer-events: auto;
      transform: none;
      transition:
        opacity var(--duration-base) var(--ease-standard),
        transform var(--duration-base) var(--ease-standard),
        visibility 0s;
    }
    .panel {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
      align-items: center;
      gap: var(--spacing-xs) var(--spacing-sm);
      inline-size: min(280px, calc(100vw - var(--spacing-md) * 2));
      padding: var(--spacing-xs) var(--spacing-md);
      border: 1px solid color-mix(in srgb, var(--color-border) 50%, transparent);
      border-radius: var(--rounded-md);
      background: var(--color-surface);
      color: var(--color-text);
      box-shadow: 0 10px 24px rgba(0, 0, 0, 0.5);
    }
    .icon {
      color: var(--color-muted);
    }
    .slider {
      min-inline-size: 0;
    }
    .value {
      min-inline-size: 3ch;
      color: var(--color-muted);
      font-size: var(--type-meta-font-size);
      font-variant-numeric: tabular-nums;
      text-align: end;
    }
    .hint {
      grid-column: 2 / -1;
      margin-block-start: calc(var(--spacing-xs) * -1);
      color: var(--color-muted);
      font-size: var(--type-meta-font-size);
      line-height: var(--type-meta-line-height);
    }
    @media (prefers-reduced-motion: reduce) {
      :host,
      :host(.shown) {
        transform: none;
      }
    }
  `,
})
export class OrVolumePopup {
  protected readonly session = inject(SessionStore);
  private readonly picker = inject(DevicePickerService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  /** Level the thumb shows, 0..100. Written by the user, or by the remote. */
  protected readonly level = signal(0);
  /** Whether the popup is in its visible window (before the remote check). */
  private readonly visible = signal(false);

  protected readonly controllable = computed(() =>
    this.session.remoteVolumeControllable(),
  );
  /** Uncontrollable remotes show the slider at max, disabled. */
  protected readonly sliderValue = computed(() =>
    this.controllable() ? this.level() : 100,
  );
  protected readonly valueText = computed(() => `${this.sliderValue()}%`);
  protected readonly shown = computed(
    () => this.session.isControllingRemote() && this.visible(),
  );

  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private pushTimer: ReturnType<typeof setTimeout> | null = null;
  private holdTimer: ReturnType<typeof setTimeout> | null = null;
  private pointerInside = false;
  private dragging = false;
  private focusInside = false;
  private lastActivity = 0;

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.clearHideTimer();
      this.clearPushTimer();
      this.clearHoldTimer();
    });

    // Reveal on every remote volume change. The first run only records the
    // current counter so an old change does not pop the popup on load.
    this.lastActivity = untracked(() => this.session.volumeActivity());
    effect(() => {
      const activity = this.session.volumeActivity();
      if (activity === this.lastActivity) return;
      this.lastActivity = activity;
      untracked(() => this.reveal());
    });

    // Follow the remote's volume, but never overwrite the thumb mid-drag or
    // while a user change is still waiting to be pushed.
    effect(() => {
      const percent = Math.round(this.session.remoteVolume() * 100);
      untracked(() => {
        if (this.dragging || this.pushTimer !== null || this.holdTimer !== null) {
          return;
        }
        this.level.set(percent);
      });
    });

    // Leaving the remote (or it losing control) hides the popup at once.
    effect(() => {
      if (this.session.isControllingRemote()) return;
      untracked(() => this.hideNow());
    });
  }

  protected onValueChange(value: number): void {
    if (!this.controllable()) return;
    this.level.set(value);
    this.reveal();
    this.clearPushTimer();
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      this.push();
    }, VOLUME_PUSH_DEBOUNCE_MS);
  }

  protected commit(): void {
    if (!this.controllable()) return;
    this.clearPushTimer();
    this.push();
    this.reveal();
    // Hold the thumb, then take the remote's level once the push has settled.
    this.clearHoldTimer();
    this.holdTimer = setTimeout(() => {
      this.holdTimer = null;
      this.level.set(Math.round(this.session.remoteVolume() * 100));
    }, VOLUME_COMMIT_HOLD_MS);
  }

  protected onPointerEnter(): void {
    this.pointerInside = true;
    this.clearHideTimer();
  }

  protected onPointerLeave(): void {
    this.pointerInside = false;
    this.scheduleHide();
  }

  protected onPointerDown(): void {
    this.dragging = true;
    this.clearHideTimer();
  }

  protected onPointerUp(): void {
    this.dragging = false;
    this.scheduleHide();
  }

  protected onFocusIn(): void {
    this.focusInside = true;
    this.clearHideTimer();
  }

  protected onFocusOut(event: FocusEvent): void {
    const next = event.relatedTarget;
    if (next instanceof Node && this.host.nativeElement.contains(next)) return;
    this.focusInside = false;
    this.scheduleHide();
  }

  private reveal(): void {
    // The device picker owns the screen; the volume popup stays out of its way.
    if (this.picker.open()) return;
    this.visible.set(true);
    this.scheduleHide();
  }

  private hideNow(): void {
    this.clearHideTimer();
    this.visible.set(false);
  }

  /** Restarts the 2s window, unless the pointer, a drag or focus holds it open. */
  private scheduleHide(): void {
    this.clearHideTimer();
    if (this.pointerInside || this.dragging || this.focusInside) return;
    this.hideTimer = setTimeout(() => {
      this.hideTimer = null;
      this.visible.set(false);
    }, VOLUME_POPUP_HIDE_MS);
  }

  private push(): void {
    this.session.setRemoteVolume(this.level() / 100);
  }

  private clearHideTimer(): void {
    if (this.hideTimer === null) return;
    clearTimeout(this.hideTimer);
    this.hideTimer = null;
  }

  private clearPushTimer(): void {
    if (this.pushTimer === null) return;
    clearTimeout(this.pushTimer);
    this.pushTimer = null;
  }

  private clearHoldTimer(): void {
    if (this.holdTimer === null) return;
    clearTimeout(this.holdTimer);
    this.holdTimer = null;
  }
}
