import { ChangeDetectionStrategy, Component, booleanAttribute, computed, inject, input, linkedSignal, signal } from '@angular/core';
import { ImportStore, PreviewPlayerService } from '@open-record/state';
import { OrButton, OrIcon, OrIconButton, OrSpinner } from '@open-record/ui';
import { SHARED_STYLES } from './shared';

let nextId = 0;

/** "Paste link": match one import item to a pasted video link. */
@Component({
  selector: 'or-link-paste',
  imports: [OrButton, OrIcon, OrIconButton, OrSpinner],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (open()) {
      <form class="paste" (submit)="submit($event)">
        <label class="field-label" [for]="id">Video link</label>
        <div class="paste-row">
          <input
            [id]="id"
            type="url"
            inputmode="url"
            autocomplete="off"
            placeholder="https://…"
            [attr.aria-describedby]="id + '-status'"
            [attr.aria-invalid]="error() ? 'true' : null"
            [value]="link()"
            [disabled]="pending()"
            (input)="onInput($event)"
          />
          <or-button type="submit" size="sm" [disabled]="pending() || disabled() || !link().trim()">
            @if (pending()) {
              <or-spinner [size]="14" label="Finding link" />
            }
            Use link
          </or-button>
          <or-icon-button icon="close" label="Close link field" [disabled]="pending()" (click)="close()" />
        </div>
        <p [id]="id + '-status'" class="status bad" role="status">
          @if (error(); as e) {
            <span class="err"><or-icon name="alert" [size]="14" />{{ e }}</span>
          }
        </p>
      </form>
    } @else {
      <or-button size="sm" [disabled]="disabled() || pending()" (click)="open.set(true)">
        <or-icon name="link" [size]="16" />{{ label() }}
      </or-button>
    }
  `,
  styles: [
    SHARED_STYLES,
    `
      :host { justify-self: stretch; }
      .paste { display: grid; gap: var(--spacing-xs); margin-top: var(--spacing-xs); }
      .field-label { font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--color-muted); }
      .paste-row { display: flex; align-items: center; gap: var(--spacing-sm); }
      input { flex: 1; min-inline-size: 0; min-block-size: var(--spacing-touch); padding: 10px; font: inherit; color: var(--color-text);
        background: var(--color-background); border: 1px solid var(--color-border); border-radius: var(--rounded-md); outline: none;
        transition: border-color var(--duration-fast) var(--ease-standard); }
      input:focus, input[aria-invalid='true'] { border-color: var(--color-primary); }
      input:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 2px; }
      .status { margin: 0; }
      .err { display: inline-flex; align-items: center; gap: 6px; }
    `,
  ],
})
export class LinkPaste {
  private readonly store = inject(ImportStore);
  private readonly preview = inject(PreviewPlayerService);

  /** Import item key. */
  readonly itemKey = input.required<string>();
  /** Another action on the item is running. */
  readonly disabled = input(false, { transform: booleanAttribute });
  /** Button text while the field is closed. */
  readonly label = input('Paste link');
  /** Show the field open from the start (the item's own link failed). */
  readonly expanded = input(false, { transform: booleanAttribute });

  protected readonly id = `or-import-link-${nextId++}`;
  protected readonly open = linkedSignal(() => this.expanded());
  protected readonly link = signal('');
  protected readonly error = signal('');
  protected readonly pending = computed(() => this.store.searching().has(this.itemKey()));

  protected onInput(event: Event): void {
    this.link.set((event.target as HTMLInputElement).value);
    this.error.set('');
  }

  protected close(): void {
    this.open.set(false);
    this.link.set('');
    this.error.set('');
  }

  protected async submit(event: Event): Promise<void> {
    event.preventDefault();
    if (this.pending() || this.disabled() || !this.link().trim()) return;
    void this.preview.stop();
    this.error.set('');
    try {
      await this.store.useLink(this.itemKey(), this.link());
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Something went wrong. Try again.');
    }
  }
}
