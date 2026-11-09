import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';
import { type IconName, type IconShape, OR_ICONS } from './icons';

/**
 * Line icon: stroked shapes plus optional filled (`solid`) brand glyphs.
 * Decorative (`aria-hidden`) unless `label` is set, in which case it is
 * exposed as an image with that accessible name.
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
          @case ('solid') {
            <svg:path class="solid" [attr.d]="asSolid(shape).d" />
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
    .solid {
      fill: currentColor;
      stroke: none;
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

  /*
   * Narrowing helpers for the template: each `@case` already guarantees the
   * shape's kind, so these only give the matching member type.
   */
  protected asPath(s: IconShape) {
    return narrow(s, 'path');
  }
  protected asSolid(s: IconShape) {
    return narrow(s, 'solid');
  }
  protected asCircle(s: IconShape) {
    return narrow(s, 'circle');
  }
  protected asRect(s: IconShape) {
    return narrow(s, 'rect');
  }
}

/** Returns the shape as its `kind` member; throws if the kind does not match. */
function narrow<K extends IconShape['kind']>(
  shape: IconShape,
  kind: K,
): Extract<IconShape, { kind: K }> {
  if (shape.kind !== kind) {
    throw new Error(`Expected icon shape "${kind}", got "${shape.kind}"`);
  }
  return shape as Extract<IconShape, { kind: K }>;
}
