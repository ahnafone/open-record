import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  Injectable,
  computed,
  inject,
  signal,
} from '@angular/core';

interface ToastState {
  readonly id: number;
  readonly message: string;
  readonly visible: boolean;
}

/** Shows short ivory toasts. Render one `<or-toast-host>` in the app shell. */
@Injectable({ providedIn: 'root' })
export class OrToast {
  private readonly state = signal<ToastState>({
    id: 0,
    message: '',
    visible: false,
  });
  private timer: ReturnType<typeof setTimeout> | null = null;

  /** Current toast; read by `<or-toast-host>`. */
  readonly current = this.state.asReadonly();

  show(message: string, durationMs = 2200): void {
    this.clearTimer();
    this.state.update((s) => ({ id: s.id + 1, message, visible: true }));
    this.timer = setTimeout(() => this.dismiss(), durationMs);
  }

  dismiss(): void {
    this.clearTimer();
    this.state.update((s) => ({ ...s, visible: false }));
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}

/**
 * Live region for `OrToast`: an ivory slip near the bottom safe area that
 * slides up 10px and fades in over 200ms. Offset it above app chrome with the
 * `--or-toast-bottom` custom property.
 */
@Component({
  selector: 'or-toast-host',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    'data-or-overlay': '',
  },
  template: `
    <div
      class="toast"
      role="status"
      aria-live="polite"
      aria-atomic="true"
      [class.is-on]="visible()"
    >
      {{ message() }}
    </div>
  `,
  styles: `
    :host {
      display: contents;
    }
    .toast {
      position: fixed;
      left: 50%;
      z-index: 60;
      bottom: calc(
        env(safe-area-inset-bottom, 0px) +
          var(--or-toast-bottom, var(--spacing-lg))
      );
      max-inline-size: 82%;
      text-align: center;
      transform: translate(-50%, 10px);
      opacity: 0;
      pointer-events: none;
      background: var(--color-ivory);
      color: var(--color-ink);
      font-family: var(--font-body);
      font-size: var(--type-body-sm-font-size);
      font-weight: 500;
      line-height: var(--type-body-sm-line-height);
      padding: 9px 14px;
      border-radius: var(--rounded-md);
      transition:
        opacity var(--duration-fast) var(--ease-standard),
        transform var(--duration-fast) var(--ease-standard);
    }
    .toast.is-on {
      opacity: 1;
      transform: translate(-50%, 0);
      transition-duration: var(--duration-base);
    }
    @media (prefers-reduced-motion: reduce) {
      .toast,
      .toast.is-on {
        transform: translate(-50%, 0);
        transition-duration: 1ms;
      }
    }
  `,
})
export class OrToastHost {
  private readonly toast = inject(OrToast);
  protected readonly visible = computed(() => this.toast.current().visible);
  protected readonly message = computed(() => this.toast.current().message);

  constructor() {
    inject(DestroyRef).onDestroy(() => this.toast.dismiss());
  }
}
