import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  effect,
  input,
  model,
  output,
  viewChild,
} from '@angular/core';
import { OrIcon } from '../icon/icon';
import { OrIconButton } from '../icon-button/icon-button';

let nextId = 0;

/** Quiet time before `settledValue` follows typing (see `OrFilterField`). */
export const FILTER_SETTLE_MS = 150;

/**
 * Search-style field for filtering a list in place: search icon, 44px input
 * and a clear button while it has text. Escape clears too. `value` is a
 * two-way model and stays instant; `settledValue` follows it once typing
 * pauses for `settleMs` (clearing is immediate), so long lists re-filter once
 * per pause instead of per keystroke. `label` is the accessible name.
 */
@Component({
  selector: 'or-filter-field',
  imports: [OrIcon, OrIconButton],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <label class="field" [for]="inputId">
      <or-icon class="ic" name="search" />
      <input
        #field
        type="search"
        autocomplete="off"
        enterkeyhint="search"
        [id]="inputId"
        [attr.aria-label]="label()"
        [attr.aria-describedby]="describedBy() || null"
        [placeholder]="placeholder()"
        [value]="value()"
        (input)="value.set($any($event.target).value)"
        (keydown.escape)="clear($event)"
      />
    </label>
    @if (value()) {
      <or-icon-button
        class="clear"
        icon="close"
        [label]="'Clear ' + label().toLowerCase()"
        (click)="clear()"
      />
    }
  `,
  styles: `
    :host {
      position: relative;
      display: block;
    }
    .field {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
      min-block-size: 48px;
      padding: 0 var(--spacing-sm);
      padding-inline-end: calc(var(--spacing-touch) + var(--spacing-xxs));
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      border-radius: var(--rounded-md);
      transition: border-color var(--duration-fast) var(--ease-standard);
    }
    .field:focus-within {
      border-color: var(--color-primary);
    }
    .ic {
      color: var(--color-muted);
    }
    input {
      flex: 1 1 0;
      min-inline-size: 0;
      min-block-size: var(--spacing-touch);
      padding: 0;
      border: 0;
      outline: none;
      background: transparent;
      color: var(--color-text);
      font: inherit;
      -webkit-appearance: none;
      appearance: none;
    }
    input::placeholder {
      color: var(--color-muted);
    }
    input::-webkit-search-cancel-button {
      -webkit-appearance: none;
    }
    .clear {
      position: absolute;
      inset-block-start: 2px;
      inset-inline-end: 2px;
    }
    @media (prefers-reduced-motion: reduce) {
      .field {
        transition-duration: 1ms;
      }
    }
  `,
})
export class OrFilterField {
  readonly value = model('');
  readonly label = input.required<string>();
  readonly placeholder = input('');
  /** Id of a status line (e.g. the match count) announced with the field. */
  readonly describedBy = input<string>();
  /** Debounce for `settledValue`, in ms. */
  readonly settleMs = input(FILTER_SETTLE_MS);
  /** `value` after typing settles; an empty value is emitted at once. */
  readonly settledValue = output<string>();

  protected readonly inputId = `or-filter-${nextId++}`;
  private readonly field = viewChild.required<ElementRef<HTMLInputElement>>('field');

  constructor() {
    let first = true;
    effect((onCleanup) => {
      const value = this.value();
      if (first || !value.trim()) {
        first = false;
        this.settledValue.emit(value);
        return;
      }
      const timer = setTimeout(() => this.settledValue.emit(value), this.settleMs());
      onCleanup(() => clearTimeout(timer));
    });
  }

  protected clear(event?: Event): void {
    if (!this.value()) return;
    event?.preventDefault();
    this.value.set('');
    this.field().nativeElement.focus();
  }
}
