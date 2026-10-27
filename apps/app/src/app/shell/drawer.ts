import {
  ChangeDetectionStrategy,
  Component,
  DOCUMENT,
  DestroyRef,
  ElementRef,
  Injector,
  afterNextRender,
  effect,
  inject,
  model,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { tabbables } from '@open-record/ui';
import { OrSidebar } from './sidebar';

/** Matches `--duration-base`; the drawer unmounts after its exit slide. */
const EXIT_MS = 200;

/**
 * Phone navigation drawer: the desktop sidebar content in a modal panel that
 * slides in from the left over a dim scrim. While open it traps Tab focus and
 * makes the rest of the page `inert` (except `data-or-overlay` elements such
 * as the toast host). Escape, a scrim tap or activating any link or button in
 * it closes it; focus returns to the opener.
 */
@Component({
  selector: 'or-drawer',
  imports: [OrSidebar],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[class.shown]': 'shown()',
    '[attr.inert]': 'open() ? null : ""',
    '(document:keydown)': 'onDocumentKeydown($event)',
    '(document:focusin)': 'onDocumentFocusin($event)',
  },
  template: `
    @if (rendered()) {
      <div class="scrim" aria-hidden="true" (click)="open.set(false)"></div>
      <div
        #panel
        class="panel"
        role="dialog"
        aria-modal="true"
        aria-label="Menu"
        tabindex="-1"
        (keydown)="onPanelKeydown($event)"
        (click)="onPanelClick($event)"
      >
        <or-sidebar class="sidebar" />
      </div>
    }
  `,
  styles: `
    :host {
      position: fixed;
      inset: 0;
      z-index: 40;
      pointer-events: none;
    }
    :host(.shown) {
      pointer-events: auto;
    }
    .scrim {
      position: absolute;
      inset: 0;
      background: color-mix(in srgb, var(--color-vinyl) 68%, transparent);
      opacity: 0;
      transition: opacity var(--duration-base) var(--ease-standard);
    }
    .panel {
      position: absolute;
      inset-block: 0;
      inset-inline-start: 0;
      display: flex;
      inline-size: min(280px, 85vw);
      transform: translateX(-100%);
      transition: transform var(--duration-base) var(--ease-standard);
      box-shadow: 0 24px 50px
        color-mix(in srgb, var(--color-vinyl) 55%, transparent);
      outline: none;
    }
    :host(.shown) .scrim {
      opacity: 1;
    }
    :host(.shown) .panel {
      transform: none;
    }
    .sidebar {
      flex: 1;
      min-width: 0;
      overflow-y: auto;
      overscroll-behavior: contain;
      padding-top: calc(env(safe-area-inset-top, 0px) + var(--spacing-md));
      padding-bottom: calc(
        env(safe-area-inset-bottom, 0px) + var(--spacing-md)
      );
      padding-left: calc(env(safe-area-inset-left, 0px) + var(--spacing-sm));
    }
    @media (prefers-reduced-motion: reduce) {
      .scrim,
      .panel {
        transition-duration: 1ms;
      }
    }
  `,
})
export class OrDrawer {
  private readonly document = inject(DOCUMENT);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  readonly open = model(false);

  /** In the DOM (stays true through the exit slide). */
  protected readonly rendered = signal(false);
  /** Slid in; toggled a frame after mounting so the transition runs. */
  protected readonly shown = signal(false);

  private readonly panel = viewChild<ElementRef<HTMLElement>>('panel');
  private returnFocusTo: HTMLElement | null = null;
  private inerted: HTMLElement[] = [];
  private exitTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    effect(() => {
      const isOpen = this.open();
      untracked(() => (isOpen ? this.activate() : this.deactivate()));
    });
    inject(DestroyRef).onDestroy(() => {
      clearTimeout(this.exitTimer);
      this.releaseInert();
    });
  }

  protected onDocumentKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || !this.open()) return;
    event.preventDefault();
    event.stopPropagation();
    this.open.set(false);
  }

  protected onDocumentFocusin(event: FocusEvent): void {
    const panel = this.panel()?.nativeElement;
    const target = event.target as Node | null;
    if (this.open() && panel && target && !panel.contains(target)) {
      this.focusInitial();
    }
  }

  /** Any link or button in the drawer navigates or opens something: close. */
  protected onPanelClick(event: MouseEvent): void {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('a, button')) this.open.set(false);
  }

  protected onPanelKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Tab') return;
    const panel = this.panel()?.nativeElement;
    if (!panel) return;
    const items = tabbables(panel);
    if (!items.length) {
      event.preventDefault();
      panel.focus();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const current = this.document.activeElement;
    if (event.shiftKey && (current === first || current === panel)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && current === last) {
      event.preventDefault();
      first.focus();
    }
  }

  private activate(): void {
    clearTimeout(this.exitTimer);
    const focused = this.document.activeElement;
    this.returnFocusTo =
      focused instanceof HTMLElement && focused !== this.document.body
        ? focused
        : null;
    this.rendered.set(true);
    this.inertOutside();
    afterNextRender(
      () => {
        this.focusInitial();
        requestAnimationFrame(() => {
          if (this.open()) this.shown.set(true);
        });
      },
      { injector: this.injector },
    );
  }

  private deactivate(): void {
    if (!this.rendered()) return;
    this.shown.set(false);
    this.releaseInert();
    const target = this.returnFocusTo;
    this.returnFocusTo = null;
    if (target?.isConnected) target.focus();
    const reduce =
      this.document.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)')
        .matches ?? false;
    clearTimeout(this.exitTimer);
    this.exitTimer = setTimeout(
      () => {
        if (!this.open()) this.rendered.set(false);
      },
      reduce ? 0 : EXIT_MS,
    );
  }

  private focusInitial(): void {
    const panel = this.panel()?.nativeElement;
    if (!panel) return;
    (tabbables(panel)[0] ?? panel).focus();
  }

  /** Marks every sibling along the path from the host to <body> as inert. */
  private inertOutside(): void {
    this.releaseInert();
    let node: HTMLElement | null = this.host.nativeElement;
    const body = this.document.body;
    while (node && node !== body && node.parentElement) {
      for (const sibling of Array.from(node.parentElement.children)) {
        if (sibling === node || !(sibling instanceof HTMLElement)) continue;
        if (
          sibling.hasAttribute('inert') ||
          sibling.hasAttribute('data-or-overlay')
        )
          continue;
        if (/^(SCRIPT|STYLE|LINK|TEMPLATE)$/.test(sibling.tagName)) continue;
        sibling.setAttribute('inert', '');
        this.inerted.push(sibling);
      }
      node = node.parentElement;
    }
  }

  private releaseInert(): void {
    for (const el of this.inerted) el.removeAttribute('inert');
    this.inerted = [];
  }
}
