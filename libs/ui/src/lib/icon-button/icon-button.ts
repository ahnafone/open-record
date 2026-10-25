import {
  ChangeDetectionStrategy,
  booleanAttribute,
  Component,
  input,
} from '@angular/core';
import { OrIcon } from '../icon/icon';
import type { IconName } from '../icon/icons';

export type IconButtonVariant = 'plain' | 'transport' | 'transport-main';

/**
 * 44px square icon button (`plain`), or a circular transport button
 * (`transport` 52px, `transport-main` 68px coral play button).
 * `label` is required: it is the accessible name. `pressed` drives
 * `aria-pressed` and turns the icon coral.
 */
@Component({
  selector: 'or-icon-button',
  imports: [OrIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[class]': '"variant-" + variant()',
  },
  template: `
    <button
      [attr.type]="type()"
      class="ib"
      [disabled]="disabled()"
      [attr.aria-label]="label()"
      [attr.aria-pressed]="pressed() === null ? null : pressed()"
    >
      @if (icon(); as name) {
        <or-icon [name]="name" [size]="iconSize()" />
      }
      <ng-content />
    </button>
  `,
  styles: `
    :host {
      display: inline-flex;
      flex: none;
    }
    .ib {
      appearance: none;
      inline-size: var(--spacing-touch);
      block-size: var(--spacing-touch);
      padding: 0;
      border: 0;
      background: transparent;
      color: var(--color-text);
      border-radius: var(--rounded-md);
      display: grid;
      place-items: center;
      cursor: pointer;
      transition:
        background var(--duration-fast) var(--ease-standard),
        transform var(--duration-fast) var(--ease-standard),
        color var(--duration-fast) var(--ease-standard);
    }
    .ib:hover {
      background: color-mix(in srgb, var(--color-text) 7%, transparent);
    }
    .ib:active {
      transform: scale(0.94);
    }
    .ib:focus-visible {
      outline: 2px solid var(--color-primary);
      outline-offset: 2px;
    }
    .ib[aria-pressed='true'] {
      color: var(--color-primary);
    }
    .ib:disabled {
      opacity: 0.42;
      cursor: not-allowed;
      transform: none;
      background: transparent;
    }

    :host(.variant-transport) .ib,
    :host(.variant-transport-main) .ib {
      inline-size: 52px;
      block-size: 52px;
      border-radius: 50%;
      background: var(--color-surface);
      border: 1px solid color-mix(in srgb, var(--color-border) 75%, transparent);
    }
    :host(.variant-transport) .ib:hover {
      background: var(--color-surface-raised);
    }
    :host(.variant-transport) .ib[aria-pressed='true'] {
      border-color: color-mix(in srgb, var(--color-primary) 55%, transparent);
    }
    :host(.variant-transport-main) .ib {
      inline-size: 68px;
      block-size: 68px;
      background: var(--color-primary);
      border-color: var(--color-primary);
      color: var(--color-on-primary);
    }
    :host(.variant-transport-main) .ib:hover {
      background: var(--color-primary-hover);
    }

    @media (prefers-reduced-motion: reduce) {
      .ib {
        transition-duration: 1ms;
      }
      .ib:active {
        transform: none;
      }
    }
  `,
})
export class OrIconButton {
  /** Accessible name (required: there is no visible text). */
  readonly label = input.required<string>();
  readonly icon = input<IconName | null>(null);
  readonly iconSize = input<number>(24);
  readonly variant = input<IconButtonVariant>('plain');
  readonly type = input<'button' | 'submit' | 'reset'>('button');
  readonly disabled = input(false, { transform: booleanAttribute });
  /** Toggle state; `null` omits `aria-pressed`. */
  readonly pressed = input<boolean | null>(null);
}
