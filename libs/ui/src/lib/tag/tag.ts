import {
  ChangeDetectionStrategy,
  booleanAttribute,
  Component,
  input,
} from '@angular/core';
import { OrIcon } from '../icon/icon';
import type { IconName } from '../icon/icons';

/** 23px pill for genre / format metadata. `ivory` flags a special attribute. */
@Component({
  selector: 'or-tag',
  imports: [OrIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[class.ivory]': 'ivory()',
  },
  template: `
    @if (icon(); as name) {
      <or-icon [name]="name" [size]="13" />
    }
    <ng-content />
  `,
  styles: `
    :host {
      display: inline-flex;
      align-items: center;
      gap: var(--spacing-xs);
      block-size: 23px;
      padding: 0 9px;
      border-radius: var(--rounded-full);
      background: color-mix(in srgb, var(--color-text) 6%, transparent);
      border: 1px solid color-mix(in srgb, var(--color-border) 55%, transparent);
      color: var(--color-muted);
      font-family: var(--font-body);
      font-size: 11px;
      line-height: 1;
      letter-spacing: 0.03em;
      white-space: nowrap;
    }
    :host(.ivory) {
      background: var(--color-ivory);
      color: var(--color-ink);
      border-color: transparent;
      font-weight: 600;
    }
  `,
})
export class OrTag {
  readonly ivory = input(false, { transform: booleanAttribute });
  /** Optional leading 13px icon (e.g. `lock`, `globe`). */
  readonly icon = input<IconName | null>(null);
}
