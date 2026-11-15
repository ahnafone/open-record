import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  inject,
  input,
  model,
  signal,
  viewChild,
} from '@angular/core';
import { OrIcon } from '@open-record/ui';
import {
  type GenreChip,
  GENRE_SUGGESTION_COUNT,
  clampActiveIndex,
  matchGenreChips,
  toggleGenreKey,
} from './genre-filter';

let nextId = 0;

/**
 * Multi-select genre filter in one inline row: selected genres as removable
 * pills, suggestion chips while nothing is selected, and a "+" button. The
 * button opens a popup with a genre text input and a listbox of matching genres
 * with counts. `selected` holds normalised keys ('' = No genre) and is two-way
 * bound.
 */
@Component({
  selector: 'or-genre-filter',
  imports: [OrIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  // Escape bubbles here from the input, option, pills or "+" (the host wraps the whole control).
  host: { '(keydown.escape)': 'onEscape($event)' },
  template: `
    <div class="genre" (focusout)="onFocusOut($event)">
      @for (p of pills(); track p.value) {
        <span class="pill">
          {{ p.label }}
          <!-- Keep focus where it is so tapping X never raises the mobile keyboard. -->
          <button
            type="button"
            class="pill-x"
            [attr.aria-label]="'Remove genre ' + p.label"
            (mousedown)="$event.preventDefault()"
            (click)="removeKey(p.value, $event)"
          >
            <or-icon name="close" [size]="12" />
          </button>
        </span>
      }

      @if (!selected().length) {
        @for (g of shownSuggestions(); track g.value) {
          <button
            type="button"
            class="suggest-chip"
            (click)="pickSuggestion(g.value, $event)"
          >
            {{ g.label }} <span class="count">{{ g.count }}</span>
          </button>
        }
      }

      <div class="add-wrap">
        <button
          #addButton
          type="button"
          class="add"
          aria-label="Filter by genre"
          aria-haspopup="dialog"
          [attr.aria-expanded]="open()"
          [attr.aria-controls]="open() ? listId : null"
          (mousedown)="$event.preventDefault()"
          (click)="toggle()"
        >
          <span aria-hidden="true">+</span>
        </button>

        @if (open()) {
          <div
            class="menu"
            role="dialog"
            aria-label="Filter by genre"
            (mousedown)="keepFocusOnPress($event)"
          >
            <input
              #field
              class="filter-input"
              type="text"
              role="combobox"
              autocomplete="off"
              aria-label="Filter by genre"
              placeholder="Filter by genre"
              aria-autocomplete="list"
              aria-expanded="true"
              [attr.aria-controls]="listId"
              [attr.aria-activedescendant]="activeId()"
              [value]="query()"
              (input)="onInput($any($event.target).value)"
              (keydown)="onKeydown($event)"
            />
            <!-- Focus stays in the input (aria-activedescendant); keep it there on press. -->
            <div
              [id]="listId"
              class="list"
              role="listbox"
              aria-label="Genres"
              aria-multiselectable="true"
              (mousedown)="$event.preventDefault()"
            >
              @for (g of matches(); track g.value; let i = $index) {
                <button
                  type="button"
                  tabindex="-1"
                  role="option"
                  class="option"
                  [id]="optionId(i)"
                  [attr.aria-selected]="isSelected(g.value)"
                  [class.is-active]="i === activeIndex()"
                  (click)="toggleOption(g.value)"
                >
                  <span class="check" aria-hidden="true">
                    @if (isSelected(g.value)) {
                      <or-icon name="check" [size]="14" />
                    }
                  </span>
                  <span class="name">{{ g.label }}</span>
                  <span class="count">{{ g.count }}</span>
                </button>
              }
            </div>
            @if (!matches().length) {
              <p class="none">No genres match</p>
            }
          </div>
        }
      </div>
    </div>
  `,
  styles: `
    :host {
      display: block;
    }
    /* Positioning context for the popup, so it spans the row, not the "+" button. */
    .genre {
      position: relative;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 4px;
    }
    .pill {
      display: inline-flex;
      align-items: center;
      gap: 2px;
      max-inline-size: 100%;
      min-block-size: 22px;
      padding: 0 2px 0 8px;
      background: var(--color-ivory);
      color: var(--color-ink);
      border-radius: var(--rounded-full);
      font-size: 12px;
      font-weight: 600;
      line-height: 1.2;
      overflow-wrap: anywhere;
    }
    .pill-x {
      position: relative;
      appearance: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex: none;
      inline-size: 18px;
      block-size: 18px;
      padding: 0;
      border: 0;
      border-radius: var(--rounded-full);
      background: transparent;
      color: inherit;
      cursor: pointer;
    }
    /* Invisible touch target (~30 x 26 px) around the 18 px visual. */
    .pill-x::after {
      content: '';
      position: absolute;
      inset: -4px -6px;
    }
    .pill-x:hover {
      background: color-mix(in srgb, var(--color-ink) 12%, transparent);
    }
    .pill-x:focus-visible,
    .add:focus-visible,
    .suggest-chip:focus-visible,
    .filter-input:focus-visible {
      outline: 2px solid var(--color-primary);
      outline-offset: 2px;
    }
    .add-wrap {
      display: inline-flex;
    }
    .add {
      appearance: none;
      position: relative;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-inline-size: 28px;
      min-block-size: 28px;
      padding: 0 8px;
      border: 1px solid color-mix(in srgb, var(--color-border) 75%, transparent);
      border-radius: var(--rounded-full);
      background: transparent;
      color: var(--color-muted);
      font: inherit;
      font-size: 15px;
      font-weight: 600;
      line-height: 1;
      cursor: pointer;
      transition: color var(--duration-fast) var(--ease-standard);
    }
    /* Invisible touch target (44 px tall) around the 28 px visual. */
    .add::after {
      content: '';
      position: absolute;
      inset: -8px -6px;
    }
    .add:hover,
    .add[aria-expanded='true'] {
      color: var(--color-primary);
    }
    /*
     * Spans the row (anchored to .genre) and is capped at 260px. The row is
     * inside the viewport, so the popup can't overflow it at any width.
     */
    .menu {
      position: absolute;
      box-sizing: border-box;
      inset-block-start: calc(100% + 4px);
      inset-inline: 0;
      z-index: 10;
      max-inline-size: 260px;
      padding: 4px;
      background: var(--color-surface-raised);
      border: 1px solid color-mix(in srgb, var(--color-border) 60%, transparent);
      border-radius: var(--rounded-md);
      box-shadow: 0 16px 30px rgba(0, 0, 0, 0.55);
    }
    .filter-input {
      display: block;
      inline-size: 100%;
      box-sizing: border-box;
      min-block-size: 44px;
      margin: 0 0 4px;
      padding: 0 10px;
      background: var(--color-background);
      color: var(--color-text);
      border: 1px solid var(--color-border);
      border-radius: var(--rounded-md);
      font: inherit;
      font-size: 14px;
      -webkit-appearance: none;
      appearance: none;
    }
    .filter-input:focus-visible {
      border-color: var(--color-primary);
    }
    .filter-input::placeholder {
      color: var(--color-muted);
    }
    .list {
      display: block;
      max-block-size: 240px;
      overflow-y: auto;
      overscroll-behavior: contain;
    }
    .option {
      appearance: none;
      display: grid;
      grid-template-columns: 18px minmax(0, 1fr) auto;
      align-items: center;
      gap: 8px;
      inline-size: 100%;
      min-block-size: 44px;
      margin: 0;
      padding: 0 8px;
      border: 0;
      border-radius: var(--rounded-md);
      background: transparent;
      color: var(--color-text);
      font: inherit;
      font-size: 13px;
      text-align: start;
      cursor: pointer;
    }
    .option.is-active,
    .option:hover {
      background: color-mix(in srgb, var(--color-text) 7%, transparent);
    }
    .check {
      display: inline-flex;
      color: var(--color-primary);
    }
    .name {
      overflow-wrap: anywhere;
    }
    .count,
    .none {
      color: var(--color-muted);
      font-variant-numeric: tabular-nums;
    }
    .count {
      font-size: 11px;
      opacity: 0.7;
    }
    .none {
      margin: 0;
      padding: 12px 10px;
      font-size: 12px;
    }
    .suggest-chip {
      appearance: none;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      min-block-size: 24px;
      padding: 0 8px;
      border: 1px solid color-mix(in srgb, var(--color-border) 70%, transparent);
      border-radius: var(--rounded-full);
      background: transparent;
      color: var(--color-muted);
      font: inherit;
      font-size: 12px;
      line-height: 1.2;
      white-space: nowrap;
      cursor: pointer;
      transition: color var(--duration-fast) var(--ease-standard);
    }
    .suggest-chip:hover {
      color: var(--color-text);
    }
    @media (prefers-reduced-motion: reduce) {
      .suggest-chip,
      .add {
        transition-duration: 1ms;
      }
    }
  `,
})
export class OrGenreFilter {
  /** Every genre option (with "No genre" when untagged tracks exist). */
  readonly options = input.required<readonly GenreChip[]>();
  /** Shown as chips, at most GENRE_SUGGESTION_COUNT, while nothing is selected. */
  readonly suggestions = input<readonly GenreChip[]>([]);
  /** Selected normalised keys, in pick order. Two-way bindable. */
  readonly selected = model<readonly string[]>([]);

  /** The popup's text input; exists only while the popup is open. */
  protected readonly field = viewChild<ElementRef<HTMLInputElement>>('field');
  /** The "+" button: always rendered, and where focus returns on close. */
  protected readonly addButton = viewChild.required<ElementRef<HTMLButtonElement>>('addButton');
  protected readonly open = signal(false);
  protected readonly query = signal('');
  /** Index into `matches()` of the highlighted option. */
  protected readonly active = signal(0);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  private readonly idBase = `or-genre-${nextId++}`;
  protected readonly listId = `${this.idBase}-list`;

  protected readonly shownSuggestions = computed(() =>
    this.suggestions().slice(0, GENRE_SUGGESTION_COUNT),
  );
  protected readonly matches = computed(() =>
    matchGenreChips(this.options(), this.query()),
  );
  /** `active` clamped to the current option count, so it never points past the list. */
  protected readonly activeIndex = computed(() =>
    clampActiveIndex(this.active(), this.matches().length),
  );
  protected readonly pills = computed(() =>
    this.selected().map((value) => ({
      value,
      label:
        this.options().find((c) => c.value === value)?.label ??
        (value === '' ? 'No genre' : value),
    })),
  );

  protected optionId(i: number): string {
    return `${this.idBase}-opt-${i}`;
  }

  /** Active option id for aria-activedescendant, or null when none is shown. */
  protected activeId(): string | null {
    return this.matches().length ? this.optionId(this.activeIndex()) : null;
  }

  protected isSelected(value: string): boolean {
    return this.selected().includes(value);
  }

  /**
   * "+" click: open the popup and focus its input once rendered; when already
   * open, close it and return focus to the "+" button.
   */
  protected toggle(): void {
    if (this.open()) {
      this.close();
      this.addButton().nativeElement.focus();
      return;
    }
    this.open.set(true);
    afterNextRender(() => this.field()?.nativeElement.focus(), {
      injector: this.injector,
    });
  }

  protected onInput(value: string): void {
    this.query.set(value);
    this.active.set(0);
  }

  protected onKeydown(event: KeyboardEvent): void {
    const count = this.matches().length;
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        event.preventDefault();
        if (!count) return;
        const step = event.key === 'ArrowDown' ? 1 : -1;
        const next = (this.activeIndex() + step + count) % count;
        this.active.set(next);
        this.scrollActiveIntoView(next);
        return;
      }
      case 'Enter': {
        if (!count) return;
        event.preventDefault();
        this.toggleOption(this.matches()[this.activeIndex()].value);
        return;
      }
    }
  }

  /**
   * Escape anywhere in the control (input, option, or "+") closes an open
   * popup and returns focus to "+". With the popup closed Escape is left alone
   * so it can reach an enclosing dialog.
   */
  protected onEscape(event: Event): void {
    if (!this.open()) return;
    event.preventDefault();
    event.stopPropagation();
    this.close();
    this.addButton().nativeElement.focus();
  }

  /**
   * Presses on the popup's non-focusable parts (padding, the "No genre
   * matches" text, the input margin) keep focus where it is, so they never
   * blur the input and close the popup. The input itself keeps its default so
   * the caret can move.
   */
  protected keepFocusOnPress(event: MouseEvent): void {
    if (event.target !== this.field()?.nativeElement) event.preventDefault();
  }

  /**
   * Select or deselect an option from the open list (click or Enter). The list
   * stays open, the query clears, and the highlight stays on this option in the
   * refreshed list, scrolled into view.
   */
  protected toggleOption(value: string): void {
    this.apply(value);
    const index = this.matches().findIndex((g) => g.value === value);
    this.active.set(clampActiveIndex(index, this.matches().length));
    afterNextRender(() => this.scrollActiveIntoView(this.activeIndex()), {
      injector: this.injector,
    });
  }

  /**
   * Suggestion chip: select only and never open the popup. A keyboard activation
   * (detail 0) moves focus to the "+" button so it is not lost to body once the
   * chips disappear; mouse and touch clicks leave focus alone.
   */
  protected pickSuggestion(value: string, event?: UIEvent): void {
    this.apply(value);
    this.close();
    if (event?.detail === 0) this.addButton().nativeElement.focus();
  }

  /**
   * Pill X: deselect only; it never opens the popup. A keyboard activation
   * (detail 0) moves focus to the "+" button before the pill is removed. Mouse
   * and touch clicks leave focus alone so tapping X never raises the keyboard.
   */
  protected removeKey(value: string, event?: UIEvent): void {
    event?.stopPropagation();
    this.selected.set(this.selected().filter((k) => k !== value));
    if (event?.detail === 0) {
      // Close first: moving focus into "+" from an open popup would not close it
      // (focus stays inside the control), so the popup would be left open.
      this.close();
      this.addButton().nativeElement.focus();
    }
  }

  private apply(value: string): void {
    this.selected.set(toggleGenreKey(this.selected(), value));
    this.query.set('');
  }

  private close(): void {
    this.open.set(false);
    this.query.set('');
    this.active.set(0);
  }

  /**
   * Close when focus leaves the control (the popup closes on outside click,
   * since a click elsewhere moves focus out). Focus moving between the "+"
   * button, the input and the pills keeps it open. `currentTarget` is the box
   * the listener is bound to.
   */
  protected onFocusOut(event: FocusEvent): void {
    const box = event.currentTarget as HTMLElement | null;
    const next = event.relatedTarget as Node | null;
    if (next && box?.contains(next)) return;
    this.close();
  }

  private scrollActiveIntoView(index: number): void {
    const el = this.host.nativeElement.querySelector<HTMLElement>(
      `#${this.optionId(index)}`,
    );
    el?.scrollIntoView?.({ block: 'nearest' });
  }
}
