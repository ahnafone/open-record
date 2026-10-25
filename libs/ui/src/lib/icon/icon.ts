import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';
import { type IconName, type IconShape, OR_ICONS } from './icons';

/**
 * Stroked line icon. Decorative (`aria-hidden`) unless `label` is set, in which
 * case it is exposed as an image with that accessible name.
 */
@Component({
  selector: 'or-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[style.--or-icon-size.px]': 'size()',
  },
  template: `
    <svg
      viewBox="0 0 24 24"
      focusable="false"
      [attr.aria-hidden]="label() ? null : 'true'"
      [attr.role]="label() ? 'img' : null"
      [attr.aria-label]="label() || null"
    >
      @for (shape of shapes(); track $index) {
        @switch (shape.kind) {
          @case ('path') {
            <svg:path [attr.d]="asPath(shape).d" />
          }
          @case ('circle') {
            <svg:circle
              [attr.cx]="asCircle(shape).cx"
              [attr.cy]="asCircle(shape).cy"
              [attr.r]="asCircle(shape).r"
            />
          }
          @case ('rect') {
            <svg:rect
              [attr.x]="asRect(shape).x"
              [attr.y]="asRect(shape).y"
              [attr.width]="asRect(shape).width"
              [attr.height]="asRect(shape).height"
              [attr.rx]="asRect(shape).rx"
            />
          }
        }
      }
    </svg>
  `,
  styles: `
    :host {
      display: inline-block;
      flex: none;
      inline-size: var(--or-icon-size, 24px);
      block-size: var(--or-icon-size, 24px);
      line-height: 0;
    }
    svg {
      display: block;
      inline-size: 100%;
      block-size: 100%;
      fill: none;
      stroke: currentColor;
      stroke-width: 1.8;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
  `,
})
export class OrIcon {
  readonly name = input.required<IconName>();
  /** Rendered size in px (square). */
  readonly size = input<number>(24);
  /** Accessible name. Leave empty for decorative icons. */
  readonly label = input<string>('');

  protected readonly shapes = computed<readonly IconShape[]>(
    () => OR_ICONS[this.name()] ?? [],
  );

  protected asPath(s: IconShape) {
    return s as Extract<IconShape, { kind: 'path' }>;
  }
  protected asCircle(s: IconShape) {
    return s as Extract<IconShape, { kind: 'circle' }>;
  }
  protected asRect(s: IconShape) {
    return s as Extract<IconShape, { kind: 'rect' }>;
  }
}
