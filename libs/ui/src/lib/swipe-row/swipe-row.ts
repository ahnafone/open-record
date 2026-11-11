import {
  DestroyRef,
  Directive,
  ElementRef,
  computed,
  inject,
  input,
  output,
} from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { OR_ICONS, type IconName, type IconShape } from '../icon/icons';
import { OrViewport } from '../viewport/viewport';
import {
  swipeAxis,
  swipeCommits,
  swipeOffset,
  type SwipeAxis,
} from './swipe-gesture';

/** What a committed swipe does: add to Your Stack, or remove from the queue. */
export type SwipeAction = 'add' | 'remove';

const ICON: Record<SwipeAction, IconName> = { add: 'queue', remove: 'close' };
const SVG_NS = 'http://www.w3.org/2000/svg';
/** Short tick when the reveal reaches the commit point; longer pulse on commit. */
const HAPTIC_TICK_MS = 8;
const HAPTIC_COMMIT_MS = 16;
/** Touches this close to the left edge belong to the system back gesture. */
const SWIPE_EDGE_PX = 24;

function buzz(ms: number): void {
  try {
    navigator.vibrate?.(ms);
  } catch {
    // Vibration unsupported or blocked: the visual reveal still works.
  }
}

/** A line icon as SVG nodes (mirrors `OrIcon`, for DOM built outside a template). */
function svgIcon(name: IconName): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.style.cssText =
    'inline-size:24px;block-size:24px;flex:none;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round';
  for (const shape of OR_ICONS[name] as readonly IconShape[]) {
    const node = document.createElementNS(
      SVG_NS,
      shape.kind === 'circle' ? 'circle' : shape.kind === 'rect' ? 'rect' : 'path',
    );
    if (shape.kind === 'path' || shape.kind === 'solid') {
      node.setAttribute('d', shape.d);
      if (shape.kind === 'solid') {
        node.setAttribute('fill', 'currentColor');
        node.setAttribute('stroke', 'none');
      }
    } else if (shape.kind === 'circle') {
      node.setAttribute('cx', String(shape.cx));
      node.setAttribute('cy', String(shape.cy));
      node.setAttribute('r', String(shape.r));
    } else {
      node.setAttribute('x', String(shape.x));
      node.setAttribute('y', String(shape.y));
      node.setAttribute('width', String(shape.width));
      node.setAttribute('height', String(shape.height));
      node.setAttribute('rx', String(shape.rx));
    }
    svg.append(node);
  }
  return svg;
}

/**
 * Mobile-only swipe-right on a list row. Dragging right reveals a coral strip
 * on the row's left with a queue (add) or close (remove) icon; past the
 * commit point, release emits `swiped` and the row snaps back. Only the native
 * phone app gets the gesture: on desktop, or in the browser, the element is
 * left alone. Vertical movement is never claimed (`touch-action: pan-y`).
 *
 * The directive moves its host with an inline transform and keeps the reveal
 * still by counter-translating it, so the host's own layout is untouched.
 */
@Directive({
  selector: '[orSwipeRow]',
  host: {
    '[style.position]': "enabled() ? 'relative' : null",
    '[style.touch-action]': "enabled() ? 'pan-y' : null",
    // content-visibility: auto paints containment, which would clip the reveal
    // that sits just left of the row's box. Only the swipe-enabled phone rows lift it.
    '[style.content-visibility]': "enabled() ? 'visible' : null",
    '(pointerdown)': 'onDown($event)',
    '(pointermove)': 'onMove($event)',
    '(pointerup)': 'onUp($event)',
    '(pointercancel)': 'onCancel()',
  },
})
export class OrSwipeRow {
  /** Reveal icon: `add` (queue) or `remove` (close). */
  readonly action = input<SwipeAction>('add');
  /** Turns the gesture off for this row, e.g. while Your Stack is locked. */
  readonly disabled = input(false);
  /** A swipe past the commit point: add or remove the row's item. */
  readonly swiped = output<void>();

  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly viewport = inject(OrViewport);
  private readonly native = Capacitor.isNativePlatform();

  /** Native phone app only: never on desktop or in the browser. */
  readonly enabled = computed(
    () => this.native && !this.viewport.isDesktop() && !this.disabled(),
  );

  private press: { id: number; x: number; y: number } | null = null;
  private axis: SwipeAxis = 'pending';
  private offset = 0;
  private armed = false;
  /** A horizontal drag just ended: its trailing click must not play the row. */
  private dragged = false;
  private reveal: HTMLElement | null = null;

  private readonly swallowClick = (event: MouseEvent): void => {
    if (!this.dragged) return;
    this.dragged = false;
    event.preventDefault();
    event.stopPropagation();
  };

  constructor() {
    // Capture phase, so the row's play button never sees a post-drag click.
    this.el.addEventListener('click', this.swallowClick, true);
    inject(DestroyRef).onDestroy(() =>
      this.el.removeEventListener('click', this.swallowClick, true),
    );
  }

  protected onDown(event: PointerEvent): void {
    this.dragged = false;
    if (!this.enabled() || !event.isPrimary || event.button > 0) return;
    if (event.clientX < SWIPE_EDGE_PX) return;
    this.press = { id: event.pointerId, x: event.clientX, y: event.clientY };
    this.axis = 'pending';
    this.armed = false;
  }

  protected onMove(event: PointerEvent): void {
    const press = this.press;
    if (!press || event.pointerId !== press.id) return;
    const dx = event.clientX - press.x;
    const dy = event.clientY - press.y;
    if (this.axis === 'pending') {
      const axis = swipeAxis(dx, dy);
      if (axis === 'pending') return;
      this.axis = axis;
      // Mostly vertical: this is a scroll. Let go and never claim it.
      if (axis === 'vertical') {
        this.press = null;
        return;
      }
      this.dragged = true;
    }
    if (this.axis !== 'horizontal') return;
    const offset = swipeOffset(dx);
    this.render(offset, false);
    const crossed = swipeCommits(offset);
    if (crossed !== this.armed) {
      this.armed = crossed;
      if (crossed) buzz(HAPTIC_TICK_MS);
    }
  }

  protected onUp(event: PointerEvent): void {
    const press = this.press;
    if (!press || event.pointerId !== press.id) return;
    this.press = null;
    if (this.axis !== 'horizontal') return;
    const commit = swipeCommits(this.offset);
    this.render(0, true);
    if (commit) {
      buzz(HAPTIC_COMMIT_MS);
      this.swiped.emit();
    }
  }

  protected onCancel(): void {
    this.press = null;
    if (this.offset > 0) this.render(0, true);
  }

  /** Move the row to `offset` px and keep the reveal in the gap behind it. */
  private render(offset: number, animate: boolean): void {
    this.offset = offset;
    const row = this.el;
    row.style.transition = animate
      ? 'transform var(--duration-fast) var(--ease-standard)'
      : 'none';
    row.style.transform = offset > 0 ? `translateX(${offset}px)` : '';
    if (offset <= 0 && !this.reveal) return;
    const reveal = this.ensureReveal();
    reveal.style.display = offset > 0 ? 'flex' : 'none';
    reveal.style.width = `${offset}px`;
    reveal.style.transform = `translateX(${-offset}px)`;
  }

  private ensureReveal(): HTMLElement {
    if (this.reveal) return this.reveal;
    const reveal = document.createElement('div');
    reveal.setAttribute('aria-hidden', 'true');
    reveal.style.cssText = [
      'position:absolute',
      'top:0',
      'bottom:0',
      'left:0',
      'display:none',
      'align-items:center',
      'box-sizing:border-box',
      'padding-inline-start:16px',
      'overflow:hidden',
      'pointer-events:none',
      'background:var(--color-primary)',
      'color:var(--color-on-primary)',
      'border-radius:var(--rounded-md)',
    ].join(';');
    reveal.append(svgIcon(ICON[this.action()]));
    this.el.prepend(reveal);
    this.reveal = reveal;
    return reveal;
  }
}
