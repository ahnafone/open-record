import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { OrIcon } from '../icon/icon';

/** Loading spinner: a stroked arc rotating every 900ms. Decorative unless `label` is set. */
@Component({
  selector: 'or-spinner',
  imports: [OrIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<or-icon name="spinner" [size]="size()" [label]="label()" />`,
  styles: `
    :host {
      display: inline-flex;
      flex: none;
      line-height: 0;
    }
    or-icon {
      animation: or-spinner-rot 900ms linear infinite;
    }
    @keyframes or-spinner-rot {
      to {
        transform: rotate(360deg);
      }
    }
    @media (prefers-reduced-motion: reduce) {
      or-icon {
        animation-duration: 2.4s;
      }
    }
  `,
})
export class OrSpinner {
  readonly size = input<number>(18);
  readonly label = input<string>('');
}
