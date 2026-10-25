import {
  ChangeDetectionStrategy,
  Component,
  DOCUMENT,
  DestroyRef,
  ElementRef,
  Injector,
  afterNextRender,
  booleanAttribute,
  effect,
  inject,
  input,
  model,
  output,
  untracked,
  viewChild,
} from '@angular/core';
import { tabbables } from './focusable';

/** Open modals, topmost last. Only the topmost one handles keys. */
const modalStack: OrModal[] = [];
let nextId = 0;

/**
 * Modal dialog: serif title, projected body, stacked actions
 * (`<div orModalActions>…</div>`), max 336px wide / 82% tall over a dim backdrop.
 *
 * While open it traps Tab focus, makes everything outside it `inert`
 * (elements marked `data-or-overlay`, such as the toast host, are left live),
 * closes on Escape or a backdrop click (when `dismissible`), and returns focus
 * to the element that was focused before it opened.
 *
 * Render it at the app-shell level (or use `OrDialog.confirm`) so no
 * transformed / overflow-hidden ancestor clips the fixed backdrop.
 */
@Component({
  selector: 'or-modal',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(document:keydown)': 'onDocumentKeydown($event)',
    '(document:focusin)': 'onDocumentFocusin($event)',
    '(pointerdown)': 'onHostPointerDown($event)',
    '(click)': 'onHostClick($event)',
  },
  template: `
    @if (open()) {
      <div class="backdrop">
        <div
          #dialog
          class="modal"
          role="dialog"
          aria-modal="true"
          tabindex="-1"
          [attr.aria-labelledby]="heading() ? headingId : null"
          [attr.aria-label]="heading() ? null : ariaLabel() || null"
          (keydown)="onDialogKeydown($event)"
        >
          @if (heading()) {
            <h2 class="title" [id]="headingId">{{ heading() }}</h2>
          }
          <div class="body"><ng-content /></div>
          <div class="actions"><ng-content select="[orModalActions]" /></div>
        </div>
      </div>
    }
  `,
  styles: `
    :host {
      display: contents;
    }
    .backdrop {
      position: fixed;
      inset: 0;
      z-index: 50;
      display: grid;
      place-items: center;
      padding: var(--spacing-lg);
      padding-top: max(var(--spacing-lg), env(safe-area-inset-top, 0px));
      padding-bottom: max(var(--spacing-lg), env(safe-area-inset-bottom, 0px));
      background: color-mix(in srgb, var(--color-vinyl) 68%, transparent);
      animation: or-modal-fade var(--duration-base) var(--ease-standard);
    }
    .modal {
      inline-size: 100%;
      max-inline-size: 336px;
      max-block-size: 82%;
      overflow: auto;
      overscroll-behavior: contain;
      background: var(--color-surface);
      color: var(--color-text);
      border: 1px solid var(--color-border);
      border-radius: var(--rounded-md);
      padding: var(--spacing-lg);
      display: grid;
      gap: var(--spacing-md);
      box-shadow: 0 24px 50px
        color-mix(in srgb, var(--color-vinyl) 55%, transparent);
    }
    .modal:focus-visible {
      outline: 2px solid var(--color-primary);
      outline-offset: 2px;
    }
    .title {
      margin: 0;
      font-family: var(--type-title-font-family);
      font-size: var(--type-title-font-size);
      font-weight: var(--type-title-font-weight);
      line-height: var(--type-title-line-height);
    }
    .body:empty,
    .actions:empty {
      display: none;
    }
    .actions {
      display: grid;
      gap: var(--spacing-sm);
    }
    @keyframes or-modal-fade {
      from {
        opacity: 0;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .backdrop {
        animation: none;
      }
    }
  `,
})
export class OrModal {
  private readonly document = inject(DOCUMENT);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  readonly open = model<boolean>(false);
  readonly heading = input<string>('');
  /** Accessible name when there is no visible heading. */
  readonly ariaLabel = input<string>('');
  /** Escape and backdrop clicks close the modal. */
  readonly dismissible = input(true, { transform: booleanAttribute });
  /** Emitted when the user dismisses via Escape or the backdrop. */
  readonly dismissed = output<void>();

  protected readonly headingId = `or-modal-title-${++nextId}`;
  private readonly dialog = viewChild<ElementRef<HTMLElement>>('dialog');

  private active = false;
  private returnFocusTo: HTMLElement | null = null;
  private inerted: HTMLElement[] = [];
  private backdropPointerDown = false;

  constructor() {
    effect(() => {
      const isOpen = this.open();
      untracked(() => (isOpen ? this.activate() : this.deactivate()));
    });
    inject(DestroyRef).onDestroy(() => this.deactivate());
  }

  /** Closes as a user dismissal (no-op when not dismissible). */
  dismiss(): void {
    if (!this.open() || !this.dismissible()) return;
    this.open.set(false);
    this.dismissed.emit();
  }

  private isBackdrop(target: EventTarget | null): boolean {
    return (
      target instanceof HTMLElement && target.classList.contains('backdrop')
    );
  }

  protected onHostPointerDown(event: PointerEvent): void {
    this.backdropPointerDown = this.isBackdrop(event.target);
  }

  /** Backdrop clicks bubble to the host (keyboard users dismiss with Escape). */
  protected onHostClick(event: MouseEvent): void {
    const fromBackdrop =
      this.backdropPointerDown && this.isBackdrop(event.target);
    this.backdropPointerDown = false;
    if (fromBackdrop) this.dismiss();
  }

  protected onDocumentKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || !this.isTopmost()) return;
    event.preventDefault();
    event.stopPropagation();
    this.dismiss();
  }

  protected onDocumentFocusin(event: FocusEvent): void {
    if (!this.isTopmost()) return;
    const dialog = this.dialog()?.nativeElement;
    const target = event.target as Node | null;
    if (dialog && target && !dialog.contains(target)) this.focusInitial();
  }

  protected onDialogKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Tab' || !this.isTopmost()) return;
    const dialog = this.dialog()?.nativeElement;
    if (!dialog) return;
    const items = tabbables(dialog);
    if (!items.length) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const current = this.document.activeElement;
    if (event.shiftKey && (current === first || current === dialog)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && current === last) {
      event.preventDefault();
      first.focus();
    }
  }

  private isTopmost(): boolean {
    return this.active && modalStack[modalStack.length - 1] === this;
  }

  private activate(): void {
    if (this.active) return;
    this.active = true;
    const focused = this.document.activeElement;
    this.returnFocusTo =
      focused instanceof HTMLElement && focused !== this.document.body
        ? focused
        : null;
    modalStack.push(this);
    this.inertOutside();
    afterNextRender(() => this.focusInitial(), { injector: this.injector });
  }

  private deactivate(): void {
    if (!this.active) return;
    this.active = false;
    const i = modalStack.indexOf(this);
    if (i >= 0) modalStack.splice(i, 1);
    for (const el of this.inerted) el.removeAttribute('inert');
    this.inerted = [];
    const target = this.returnFocusTo;
    this.returnFocusTo = null;
    if (target && target.isConnected) target.focus();
  }

  private focusInitial(): void {
    if (!this.active) return;
    const dialog = this.dialog()?.nativeElement;
    if (!dialog) return;
    (tabbables(dialog)[0] ?? dialog).focus();
  }

  /** Marks every sibling along the path from the host to <body> as inert. */
  private inertOutside(): void {
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
}
