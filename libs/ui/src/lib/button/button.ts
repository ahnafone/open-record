import {
  ChangeDetectionStrategy,
  booleanAttribute,
  Component,
  input,
} from '@angular/core';

export type ButtonVariant = 'default' | 'primary' | 'danger';
export type ButtonSize = 'md' | 'sm';

/**
 * Text button. Projected content is the label (an `<or-icon>` may lead it).
 * Listen with `(click)` on `<or-button>`; a disabled button emits no clicks.
 */
@Component({
  selector: 'or-button',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[class.block]': 'block()',
  },
  template: `
    <button
      [attr.type]="type()"
      [class]="'btn variant-' + variant() + ' size-' + size()"
      [disabled]="disabled()"
      [attr.aria-label]="ariaLabel() || null"
      [attr.aria-pressed]="pressed() === null ? null : pressed()"
    >
      <ng-content />
    </button>
  `,
  styles: `
    :host {
      display: inline-flex;
    }
    :host(.block) {
      display: flex;
    }
    .btn {
      appearance: none;
      flex: 1 1 auto;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: var(--spacing-sm);
      min-block-size: var(--spacing-touch);
      min-inline-size: var(--spacing-touch);
      padding: 0 14px;
      font: inherit;
      font-family: var(--type-button-font-family);
      font-size: var(--type-button-font-size);
      line-height: var(--type-button-line-height);
      color: var(--color-text);
      background: var(--color-surface);
      border: 1px solid color-mix(in srgb, var(--color-border) 75%, transparent);
      border-radius: var(--rounded-md);
      cursor: pointer;
      transition:
        background var(--duration-fast) var(--ease-standard),
        transform var(--duration-fast) var(--ease-standard),
        opacity var(--duration-fast) var(--ease-standard);
    }
    .btn:hover {
      background: var(--color-surface-raised);
    }
    .btn:active {
      transform: scale(0.97);
    }
    .btn:focus-visible {
      outline: 2px solid var(--color-primary);
      outline-offset: 2px;
    }
    .variant-primary {
      background: var(--color-primary);
      border-color: var(--color-primary);
      color: var(--color-on-primary);
      font-weight: var(--type-button-font-weight);
    }
    .variant-primary:hover {
      background: var(--color-primary-hover);
    }
    .variant-danger {
      color: var(--color-primary);
      border-color: color-mix(in srgb, var(--color-primary) 55%, transparent);
      background: color-mix(in srgb, var(--color-primary) 8%, transparent);
    }
    .variant-danger:hover {
      background: color-mix(in srgb, var(--color-primary) 16%, transparent);
    }
    .size-sm {
      font-size: var(--type-body-sm-font-size);
      padding: 0 var(--spacing-md);
    }
    .btn:disabled {
      opacity: 0.42;
      cursor: not-allowed;
      transform: none;
    }
    .btn:disabled:hover {
      background: var(--color-surface);
    }
    .variant-primary:disabled:hover {
      background: var(--color-primary);
    }
    .variant-danger:disabled:hover {
      background: color-mix(in srgb, var(--color-primary) 8%, transparent);
    }
    @media (prefers-reduced-motion: reduce) {
      .btn {
        transition-duration: 1ms;
      }
      .btn:active {
        transform: none;
      }
    }
  `,
})
export class OrButton {
  readonly variant = input<ButtonVariant>('default');
  readonly size = input<ButtonSize>('md');
  readonly type = input<'button' | 'submit' | 'reset'>('button');
  readonly disabled = input(false, { transform: booleanAttribute });
  /** Stretch to the container width. */
  readonly block = input(false, { transform: booleanAttribute });
  /** Accessible name when the visible label is not enough. */
  readonly ariaLabel = input<string>('');
  /** Toggle state; `null` omits `aria-pressed`. */
  readonly pressed = input<boolean | null>(null);
}
