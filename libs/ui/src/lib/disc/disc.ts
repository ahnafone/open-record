import {
  ChangeDetectionStrategy,
  booleanAttribute,
  Component,
  input,
} from '@angular/core';

/**
 * A grooved vinyl disc with an ivory centre label and spindle hole.
 * Size it from the outside (width); it keeps a 1:1 ratio. Decorative.
 */
@Component({
  selector: 'or-disc',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    'aria-hidden': 'true',
    '[class.is-spinning]': 'spinning()',
  },
  template: `
    @if (showLabel()) {
      <span class="label">{{ label() }}</span>
    }
  `,
  styles: `
    :host {
      --or-groove: color-mix(
        in srgb,
        var(--color-surface) 65%,
        var(--color-vinyl)
      );
      position: relative;
      display: block;
      inline-size: 100%;
      aspect-ratio: 1;
      border-radius: 50%;
      background: repeating-radial-gradient(
        circle at 50% 50%,
        var(--color-vinyl) 0 2px,
        var(--or-groove) 2px 3.5px
      );
      box-shadow:
        inset 0 0 0 1px color-mix(in srgb, var(--color-text) 5%, transparent),
        0 10px 24px color-mix(in srgb, var(--color-vinyl) 50%, transparent);
    }
    :host(.is-spinning) {
      animation: or-disc-spin 8s linear infinite;
    }
    .label {
      position: absolute;
      left: 50%;
      top: 50%;
      inline-size: 31%;
      aspect-ratio: 1;
      transform: translate(-50%, -50%);
      border-radius: 50%;
      background: var(--color-ivory);
      color: var(--color-ink);
      display: grid;
      place-items: center;
      overflow: hidden;
      font: 600 9px/1 var(--font-body);
      letter-spacing: 0.03em;
    }
    .label::after {
      content: '';
      position: absolute;
      inline-size: 12%;
      aspect-ratio: 1;
      border-radius: 50%;
      background: var(--color-vinyl);
    }
    @keyframes or-disc-spin {
      to {
        transform: rotate(360deg);
      }
    }
    @media (prefers-reduced-motion: reduce) {
      :host(.is-spinning) {
        animation: none;
      }
    }
  `,
})
export class OrDisc {
  /** Text printed on the centre label (e.g. a catalogue number). */
  readonly label = input<string>('');
  readonly showLabel = input(true, { transform: booleanAttribute });
  /** Rotates once every 8s while true (stopped under reduced motion). */
  readonly spinning = input(false, { transform: booleanAttribute });
}
