import {
  ChangeDetectionStrategy,
  Component,
  booleanAttribute,
  input,
  output,
} from '@angular/core';

let nextId = 0;

/**
 * Full-width settings row with an on/off switch (`role="switch"`). The whole
 * row is the touch target. The parent owns the value: bind `[checked]` and
 * persist from `(checkedChange)`. On is shown by a coral track plus the thumb
 * position, so state never relies on colour alone.
 */
@Component({
  selector: 'or-switch',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button
      type="button"
      role="switch"
      class="row"
      [attr.aria-checked]="checked()"
      [attr.aria-describedby]="description() ? descId : null"
      [disabled]="disabled()"
      (click)="checkedChange.emit(!checked())"
    >
      <span class="text">
        <span class="label">{{ label() }}</span>
        @if (description()) {
          <span class="desc" [id]="descId">{{ description() }}</span>
        }
      </span>
      <span class="track" [class.is-on]="checked()" aria-hidden="true">
        <span class="thumb"></span>
      </span>
    </button>
  `,
  styles: `
    :host {
      display: block;
    }
    .row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--spacing-md);
      inline-size: 100%;
      min-block-size: var(--spacing-touch);
      padding: var(--spacing-sm) 0;
      font: inherit;
      color: var(--color-text);
      text-align: start;
      background: transparent;
      border: 0;
      border-radius: var(--rounded-md);
      cursor: pointer;
    }
    .row:focus-visible {
      outline: 2px solid var(--color-primary);
      outline-offset: 2px;
    }
    .row:disabled {
      opacity: 0.42;
      cursor: not-allowed;
    }
    .text {
      display: grid;
      gap: 2px;
      min-inline-size: 0;
    }
    .label {
      font-size: 14px;
      font-weight: 600;
      line-height: 1.3;
    }
    .desc {
      font-size: 12px;
      line-height: 1.4;
      color: var(--color-muted);
    }
    .track {
      position: relative;
      flex: none;
      inline-size: 40px;
      block-size: 24px;
      background: var(--color-background);
      border: 1px solid var(--color-border);
      border-radius: var(--rounded-full);
      transition:
        background var(--duration-fast) var(--ease-standard),
        border-color var(--duration-fast) var(--ease-standard);
    }
    .thumb {
      position: absolute;
      inset-block-start: 3px;
      inset-inline-start: 3px;
      inline-size: 16px;
      block-size: 16px;
      background: var(--color-muted);
      border-radius: 50%;
      transition:
        transform var(--duration-fast) var(--ease-standard),
        background var(--duration-fast) var(--ease-standard);
    }
    .track.is-on {
      background: var(--color-primary);
      border-color: var(--color-primary);
    }
    .track.is-on .thumb {
      background: var(--color-on-primary);
      transform: translateX(16px);
    }
    @media (prefers-reduced-motion: reduce) {
      .track,
      .thumb {
        transition-duration: 1ms;
      }
    }
  `,
})
export class OrSwitch {
  readonly label = input.required<string>();
  readonly description = input('');
  readonly checked = input(false, { transform: booleanAttribute });
  readonly disabled = input(false, { transform: booleanAttribute });
  readonly checkedChange = output<boolean>();

  protected readonly descId = `or-switch-desc-${nextId++}`;
}
