import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  inject,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { MAX_ACCESS_NOTE_LENGTH, type AccessStatus } from '@open-record/models';
import { AccessRequestService, AuthStore } from '@open-record/state';
import { OrButton, OrIcon, OrSpinner } from '@open-record/ui';

/** Turnstile, explicit mode: we render the widget ourselves. */
const TURNSTILE_SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

interface TurnstileApi {
  render(
    element: HTMLElement,
    options: {
      sitekey: string;
      callback: (token: string) => void;
      'error-callback'?: () => void;
      'expired-callback'?: () => void;
    },
  ): string;
  reset(widgetId?: string): void;
  remove(widgetId?: string): void;
}

function turnstileApi(): TurnstileApi | undefined {
  return (globalThis as unknown as { turnstile?: TurnstileApi }).turnstile;
}

/** One script tag per page; a failed load can be retried. */
let scriptLoad: Promise<TurnstileApi> | undefined;

function loadTurnstile(): Promise<TurnstileApi> {
  scriptLoad ??= new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = TURNSTILE_SCRIPT;
    script.async = true;
    script.onload = () => {
      const api = turnstileApi();
      if (api) resolve(api);
      else {
        scriptLoad = undefined;
        reject(new Error('Verification did not load. Try again.'));
      }
    };
    script.onerror = () => {
      scriptLoad = undefined;
      script.remove();
      reject(new Error('Verification could not load. Check your connection and try again.'));
    };
    document.head.append(script);
  });
  return scriptLoad;
}

/** The server answers every accepted request the same way, so the copy is neutral. */
const RECEIVED_TEXT = 'Request received. If this address is eligible you will hear by email.';

/**
 * "Request access" on the public server (sign-up is closed there). Email, an
 * optional note and a Turnstile check; the admin reviews each request.
 */
@Component({
  selector: 'or-request-access-form',
  imports: [OrButton, OrIcon, OrSpinner],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <form class="form" (submit)="submit($event)">
      <label class="field-label" for="or-request-email">Email</label>
      <input
        id="or-request-email"
        class="input"
        type="email"
        inputmode="email"
        autocomplete="email"
        autocapitalize="off"
        spellcheck="false"
        aria-describedby="or-request-status"
        [value]="email()"
        (input)="email.set(value($event))"
      />

      <label class="field-label" for="or-request-note">Note (optional)</label>
      <textarea
        id="or-request-note"
        class="input note-input"
        rows="3"
        [maxLength]="maxNote"
        aria-describedby="or-request-status"
        [value]="note()"
        (input)="note.set(value($event))"
      ></textarea>

      <div class="turnstile" #widget></div>

      <div class="actions">
        <or-button type="submit" variant="primary" [disabled]="busy()">
          Request access
        </or-button>
        <or-button [disabled]="busy()" (click)="backToSignIn.emit()">Back to sign in</or-button>
      </div>

      <p id="or-request-status" class="status" role="status">
        @if (error(); as e) {
          <span class="bad"><or-icon name="alert" [size]="14" />{{ e }}</span>
        } @else if (busy()) {
          <span class="muted"><or-spinner [size]="14" />Sending…</span>
        } @else if (result()) {
          <span class="muted">{{ receivedText }}</span>
        }
      </p>
    </form>
  `,
  styles: `
    :host {
      display: block;
    }
    .form {
      display: grid;
      gap: var(--spacing-xs);
    }
    .field-label {
      margin-top: var(--spacing-xs);
      font-size: 11px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--color-muted);
    }
    .input {
      padding: var(--spacing-sm);
      font: inherit;
      color: var(--color-text);
      background: var(--color-background);
      border: 1px solid var(--color-border);
      border-radius: var(--rounded-md);
      outline: none;
    }
    .input:focus {
      border-color: var(--color-primary);
    }
    .input::placeholder {
      color: var(--color-muted);
    }
    .note-input {
      resize: vertical;
      min-block-size: 80px;
    }
    .turnstile {
      min-block-size: 65px;
      margin-top: var(--spacing-xs);
    }
    .actions {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: var(--spacing-sm);
      margin-top: var(--spacing-sm);
    }
    .status {
      margin: var(--spacing-xs) 0 0;
      min-block-size: 18px;
      font-size: 12px;
      line-height: 1.5;
    }
    .bad,
    .muted {
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .bad {
      color: var(--color-primary);
    }
    .muted {
      color: var(--color-muted);
    }
  `,
})
export class RequestAccessForm implements AfterViewInit, OnDestroy {
  private readonly auth = inject(AuthStore);
  private readonly requests = inject(AccessRequestService);
  private readonly widget = viewChild.required<ElementRef<HTMLElement>>('widget');

  protected readonly maxNote = MAX_ACCESS_NOTE_LENGTH;
  protected readonly receivedText = RECEIVED_TEXT;
  protected readonly email = signal('');
  protected readonly note = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly result = signal<AccessStatus | null>(null);

  private token = '';
  private widgetId: string | undefined;
  private api: TurnstileApi | undefined;

  /** Emitted by "Back to sign in" (the parent shows the sign-in form again). */
  readonly backToSignIn = output<void>();

  ngAfterViewInit(): void {
    void this.renderWidget();
  }

  ngOnDestroy(): void {
    if (this.api && this.widgetId !== undefined) this.api.remove(this.widgetId);
  }

  protected value(event: Event): string {
    return (event.target as HTMLInputElement | HTMLTextAreaElement).value;
  }

  protected async submit(event: Event): Promise<void> {
    event.preventDefault();
    if (this.busy()) return;
    const email = this.email().trim();
    if (!email) {
      this.error.set('Enter your email address.');
      return;
    }
    if (!this.token) {
      this.error.set('Complete the verification first.');
      return;
    }
    this.busy.set(true);
    this.error.set('');
    this.result.set(null);
    try {
      this.result.set(await this.requests.submit(email, this.note(), this.token));
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Could not send the request. Try again.');
    } finally {
      this.busy.set(false);
      // A Turnstile token works once: reset for the next attempt.
      this.token = '';
      if (this.api && this.widgetId !== undefined) this.api.reset(this.widgetId);
    }
  }

  private async renderWidget(): Promise<void> {
    const siteKey = this.auth.project()?.turnstileSiteKey;
    if (!siteKey) {
      this.error.set('Access requests are not available on this server.');
      return;
    }
    try {
      this.api = await loadTurnstile();
      this.widgetId = this.api.render(this.widget().nativeElement, {
        sitekey: siteKey,
        callback: (token) => (this.token = token),
        'error-callback': () => {
          this.token = '';
          this.error.set('Verification failed. Try again.');
        },
        'expired-callback': () => (this.token = ''),
      });
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Verification could not load.');
    }
  }
}
