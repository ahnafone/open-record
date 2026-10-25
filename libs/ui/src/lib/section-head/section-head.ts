import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * Serif section title followed by a flexible 1px rule, like a divider card in
 * a record bin. Optional trailing content (e.g. an action) is projected after the rule.
 */
@Component({
  selector: 'or-section-head',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @switch (level()) {
      @case (3) {
        <h3 class="title">{{ heading() }}</h3>
      }
      @default {
        <h2 class="title">{{ heading() }}</h2>
      }
    }
    <span class="rule" aria-hidden="true"></span>
    <ng-content />
  `,
  styles: `
    :host {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
      margin: var(--spacing-lg) 0 var(--spacing-xxs);
    }
    .title {
      margin: 0;
      font-family: var(--type-section-font-family);
      font-size: var(--type-section-font-size);
      font-weight: var(--type-section-font-weight);
      line-height: var(--type-section-line-height);
      color: var(--color-text);
    }
    .rule {
      flex: 1 1 auto;
      block-size: 1px;
      background: color-mix(in srgb, var(--color-border) 55%, transparent);
    }
  `,
})
export class OrSectionHead {
  readonly heading = input.required<string>();
  readonly level = input<2 | 3>(2);
}
