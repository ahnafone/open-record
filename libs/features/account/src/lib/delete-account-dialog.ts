import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  model,
  output,
  signal,
} from '@angular/core';
import { OrButton, OrModal } from '@open-record/ui';

/** What the user types to confirm deleting the account. */
export const DELETE_CONFIRM_WORD = 'DELETE';

/**
 * "Delete account" confirmation: explains what goes and only enables the
 * danger button once the user has typed DELETE.
 */
@Component({
  selector: 'or-delete-account-dialog',
  imports: [OrButton, OrModal],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <or-modal heading="Delete account?" [(open)]="open" (dismissed)="reset()">
      <form class="form" novalidate (submit)="submit($event)">
        <p class="message">
          This permanently deletes {{ email() || 'your account' }} and the
          library and playlists synced to it. Music saved on this device stays
          here. This cannot be undone.
        </p>
        <label class="field-label" for="or-delete-confirm"
          >Type {{ word }} to confirm</label
        >
        <input
          id="or-delete-confirm"
          class="input"
          type="text"
          autocomplete="off"
          autocapitalize="characters"
          spellcheck="false"
          [value]="typed()"
          (input)="typed.set(value($event))"
        />
      </form>
      <div orModalActions>
        <or-button variant="danger" block [disabled]="!matches() || busy()" (click)="submit()">
          Delete account
        </or-button>
        <or-button block (click)="close()">Cancel</or-button>
      </div>
    </or-modal>
  `,
  styles: `
    :host {
      display: contents;
    }
    .form {
      display: grid;
      gap: var(--spacing-xs);
    }
    .message {
      margin: 0 0 var(--spacing-xs);
      color: var(--color-muted);
      font-size: var(--type-body-sm-font-size);
      line-height: var(--type-body-sm-line-height);
      overflow-wrap: anywhere;
    }
    .field-label {
      font-size: 11px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--color-muted);
    }
    .input {
      min-block-size: var(--spacing-touch);
      padding: 0 var(--spacing-sm);
      font: inherit;
      color: var(--color-text);
      background: var(--color-background);
      border: 1px solid var(--color-border);
      border-radius: var(--rounded-md);
      outline: none;
      transition: border-color var(--duration-fast) var(--ease-standard);
    }
    .input:focus {
      border-color: var(--color-primary);
    }
    [orModalActions] {
      display: grid;
      gap: var(--spacing-sm);
    }
    @media (prefers-reduced-motion: reduce) {
      .input {
        transition-duration: 1ms;
      }
    }
  `,
})
export class DeleteAccountDialog {
  readonly open = model(false);
  readonly email = input<string | undefined>('');
  readonly busy = input(false);
  /** The user typed the confirmation and pressed Delete. */
  readonly confirmed = output<void>();

  protected readonly word = DELETE_CONFIRM_WORD;
  protected readonly typed = signal('');
  protected readonly matches = computed(
    () => this.typed().trim().toUpperCase() === DELETE_CONFIRM_WORD,
  );

  protected value(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected submit(event?: Event): void {
    event?.preventDefault();
    if (!this.matches() || this.busy()) return;
    this.confirmed.emit();
  }

  protected close(): void {
    this.open.set(false);
    this.reset();
  }

  protected reset(): void {
    this.typed.set('');
  }
}
