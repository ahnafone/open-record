import { ChangeDetectionStrategy, Component } from '@angular/core';

/** Dashed-border empty state with centred muted copy (projected). */
@Component({
  selector: 'or-empty-state',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<ng-content />`,
  styles: `
    :host {
      display: block;
      color: var(--color-muted);
      font-size: var(--type-body-sm-font-size);
      line-height: var(--type-body-sm-line-height);
      text-align: center;
      padding: 20px var(--spacing-md);
      border: 1px dashed
        color-mix(in srgb, var(--color-border) 55%, transparent);
      border-radius: var(--rounded-md);
    }
  `,
})
export class OrEmptyState {}
