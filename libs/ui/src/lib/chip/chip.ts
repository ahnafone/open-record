import {
  ChangeDetectionStrategy,
  booleanAttribute,
  Component,
  input,
  model,
} from '@angular/core';

/**
 * Outlined filter pill. Selected chips become an ivory "price sticker".
 * Two-way bind `[(selected)]`; set `toggleable` to false to control it
 * entirely from the parent (e.g. single-select groups) via `(click)`.
 */
@Component({
  selector: 'or-chip',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button
      type="button"
      class="chip"
      [class.is-on]="selected()"
      [disabled]="disabled()"
      [attr.aria-pressed]="selected()"
      (click)="toggle()"
    >
      <ng-content />
    </button>
  `,
  styles: `
    :host {
      display: inline-flex;
      flex: none;
    }
    .chip {
      appearance: none;
      font: inherit;
      font-size: 13px;
      line-height: var(--type-button-line-height);
      color: var(--color-muted);
      white-space: nowrap;
      background: transparent;
      border: 1px solid color-mix(in srgb, var(--color-border) 70%, transparent);
      border-radius: var(--rounded-full);
      min-block-size: var(--spacing-touch);
      min-inline-size: var(--spacing-touch);
      padding: 0 14px;
      cursor: pointer;
      transition:
        background var(--duration-fast) var(--ease-standard),
        color var(--duration-fast) var(--ease-standard),
        border-color var(--duration-fast) var(--ease-standard);
    }
    .chip:hover {
      color: var(--color-text);
    }
    .chip:focus-visible {
      outline: 2px solid var(--color-primary);
      outline-offset: 2px;
    }
    .chip.is-on {
      background: var(--color-ivory);
      color: var(--color-ink);
      border-color: var(--color-ivory);
      font-weight: 600;
    }
    .chip:disabled {
      opacity: 0.42;
      cursor: not-allowed;
    }
    @media (prefers-reduced-motion: reduce) {
      .chip {
        transition-duration: 1ms;
      }
    }
  `,
})
export class OrChip {
  readonly selected = model<boolean>(false);
  readonly toggleable = input(true, { transform: booleanAttribute });
  readonly disabled = input(false, { transform: booleanAttribute });

  protected toggle(): void {
    if (this.toggleable()) this.selected.update((v) => !v);
  }
}
