import {
  booleanAttribute,
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { AuthStore, SyncStore } from '@open-record/state';
import { OrButton, OrIcon, OrSectionHead, OrSpinner, OrToast } from '@open-record/ui';

/**
 * Settings "Account" section: Supabase email/password sign-in. The project
 * comes from the build or the download server; users never enter it. When the
 * server has no accounts set up, this says so and the app stays browse-only.
 */
@Component({
  selector: 'or-account-section',
  imports: [NgTemplateOutlet, OrButton, OrIcon, OrSectionHead, OrSpinner],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (!compact()) {
      <or-section-head heading="Account" />
      <p class="lede">
        Browse and play without an account. Sign in to save music, build
        playlists and import your library.
        @if (sync.available) {
          Your library and playlists (not audio files) sync across your devices.
        }
      </p>
    }

    @switch (view()) {
      @case ('loading') {
        <p class="status" role="status">
          <span class="muted"><or-spinner [size]="14" />Checking your account…</span>
        </p>
      }
      @case ('unconfigured') {
        <p class="note">
          Accounts are not set up, or this device can't reach the server yet.
          Check the server address below, then try again.
        </p>
        <or-button size="sm" (click)="auth.refresh()">Try again</or-button>
      }
      @case ('recovery') {
        <form class="form" (submit)="saveNewPassword($event)">
          <label class="field-label" for="or-auth-new-password">New password</label>
          <div class="pw">
            <input
              id="or-auth-new-password"
              class="input"
              [type]="showPassword() ? 'text' : 'password'"
              autocomplete="new-password"
              autocapitalize="off"
              spellcheck="false"
              aria-describedby="or-auth-status"
              [attr.aria-invalid]="auth.error() ? 'true' : null"
              [value]="password()"
              (input)="password.set(value($event))"
            />
            <button
              type="button"
              class="pw-toggle"
              [attr.aria-label]="showPassword() ? 'Hide password' : 'Show password'"
              [attr.aria-pressed]="showPassword()"
              (click)="showPassword.set(!showPassword())"
            >
              <or-icon [name]="showPassword() ? 'eye-off' : 'eye'" [size]="20" />
            </button>
          </div>
          <div class="actions">
            <or-button type="submit" variant="primary" [disabled]="auth.busy()"
              >Save new password</or-button
            >
          </div>
          <ng-container *ngTemplateOutlet="status" />
        </form>
      }
      @case ('signedOut') {
        <form class="form" (submit)="signIn($event)">
          <label class="field-label" for="or-auth-email">Email</label>
          <input
            id="or-auth-email"
            class="input"
            type="email"
            inputmode="email"
            autocomplete="username"
            autocapitalize="off"
            spellcheck="false"
            aria-describedby="or-auth-status"
            [attr.aria-invalid]="auth.error() ? 'true' : null"
            [value]="email()"
            (input)="email.set(value($event))"
          />
          <label class="field-label" for="or-auth-password">Password</label>
          <div class="pw">
            <input
              id="or-auth-password"
              class="input"
              [type]="showPassword() ? 'text' : 'password'"
              [attr.autocomplete]="creating() ? 'new-password' : 'current-password'"
              autocapitalize="off"
              spellcheck="false"
              aria-describedby="or-auth-status"
              [attr.aria-invalid]="auth.error() ? 'true' : null"
              [value]="password()"
              (input)="password.set(value($event))"
            />
            <button
              type="button"
              class="pw-toggle"
              [attr.aria-label]="showPassword() ? 'Hide password' : 'Show password'"
              [attr.aria-pressed]="showPassword()"
              (click)="showPassword.set(!showPassword())"
            >
              <or-icon [name]="showPassword() ? 'eye-off' : 'eye'" [size]="20" />
            </button>
          </div>
          <div class="actions">
            @if (creating()) {
              <or-button type="submit" variant="primary" [disabled]="auth.busy()"
                >Create account</or-button
              >
              <or-button [disabled]="auth.busy()" (click)="setCreating(false)"
                >I have an account</or-button
              >
            } @else {
              <or-button type="submit" variant="primary" [disabled]="auth.busy()"
                >Sign in</or-button
              >
              <or-button [disabled]="auth.busy()" (click)="setCreating(true)"
                >Create account</or-button
              >
            }
          </div>
          <ng-container *ngTemplateOutlet="status" />
        </form>
        <div class="links">
          @if (!creating()) {
            <button
              type="button"
              class="text-link"
              [disabled]="auth.busy()"
              (click)="resetPassword()"
            >
              Forgot password?
            </button>
          }
        </div>
      }
      @case ('signedIn') {
        <div class="signed-in">
          <or-icon name="check" [size]="18" />
          <span class="who">
            Signed in as
            <strong>{{ auth.user()?.email || 'your account' }}</strong>
          </span>
        </div>
        @if (sync.available) {
          <p class="status sync-line" role="status" aria-live="polite">
            @switch (sync.status()) {
              @case ('syncing') {
                <span class="muted"><or-spinner [size]="14" />Syncing your library…</span>
              }
              @case ('error') {
                <span class="bad"><or-icon name="alert" [size]="14" />{{ sync.error() }}</span>
              }
              @default {
                <span class="muted">{{ syncedLabel() }}</span>
              }
            }
          </p>
          <div class="actions">
            <or-button
              [disabled]="auth.busy() || sync.status() === 'syncing'"
              (click)="syncNow()"
              >Sync now</or-button
            >
            <or-button [disabled]="auth.busy()" (click)="signOut()">Sign out</or-button>
          </div>
        } @else {
          <or-button block [disabled]="auth.busy()" (click)="signOut()">Sign out</or-button>
        }
        <ng-container *ngTemplateOutlet="status" />
      }
    }

    <ng-template #status>
      <p id="or-auth-status" class="status" role="status">
        @if (auth.error(); as e) {
          <span class="bad"><or-icon name="alert" [size]="14" />{{ e }}</span>
        } @else if (auth.busy()) {
          <span class="muted"><or-spinner [size]="14" />Working…</span>
        } @else if (auth.notice(); as n) {
          <span class="muted">{{ n }}</span>
        }
      </p>
    </ng-template>
  `,
  styles: `
    :host {
      display: block;
    }
    .lede,
    .note {
      margin: var(--spacing-xs) 0 var(--spacing-md);
      font-size: 13px;
      line-height: 1.45;
      color: var(--color-muted);
    }
    .note {
      margin: var(--spacing-sm) 0 0;
      font-size: 12px;
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
    .pw {
      display: grid;
    }
    .pw > * {
      grid-area: 1 / 1;
    }
    .pw .input {
      padding-inline-end: var(--spacing-touch);
    }
    .pw-toggle {
      justify-self: end;
      inline-size: var(--spacing-touch);
      block-size: var(--spacing-touch);
      display: inline-grid;
      place-items: center;
      color: var(--color-muted);
      background: transparent;
      border: 0;
      border-radius: var(--rounded-md);
      cursor: pointer;
    }
    .pw-toggle[aria-pressed='true'] {
      color: var(--color-primary);
    }
    .pw-toggle:focus-visible {
      outline: 2px solid var(--color-primary);
      outline-offset: 2px;
    }
    .input::placeholder {
      color: var(--color-muted);
    }
    .input:focus,
    .input[aria-invalid='true'] {
      border-color: var(--color-primary);
    }
    .actions {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: var(--spacing-sm);
      margin-top: var(--spacing-sm);
    }
    /* Reserved status line so the form does not jump. */
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
    .links {
      display: flex;
      flex-wrap: wrap;
      gap: var(--spacing-md);
    }
    .text-link {
      display: inline-flex;
      align-items: center;
      min-block-size: var(--spacing-touch);
      padding: 0;
      font: inherit;
      font-size: 13px;
      color: var(--color-text);
      text-decoration: underline;
      text-underline-offset: 3px;
      background: transparent;
      border: 0;
      border-radius: var(--rounded-md);
      cursor: pointer;
    }
    .text-link:disabled {
      opacity: 0.42;
      cursor: default;
    }
    .text-link:focus-visible {
      outline: 2px solid var(--color-primary);
      outline-offset: 2px;
    }
    .signed-in {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
      min-block-size: var(--spacing-touch);
      margin-bottom: var(--spacing-sm);
      font-size: 14px;
    }
    .sync-line {
      margin: 0;
    }
    .who {
      min-inline-size: 0;
      overflow-wrap: anywhere;
    }
    @media (prefers-reduced-motion: reduce) {
      .input {
        transition-duration: 1ms;
      }
    }
  `,
})
export class AccountSection {
  protected readonly auth = inject(AuthStore);
  protected readonly sync = inject(SyncStore);
  private readonly toast = inject(OrToast);

  protected readonly email = signal('');
  protected readonly password = signal('');
  protected readonly creating = signal(false);
  protected readonly showPassword = signal(false);
  /** Form only (no heading or lede), for the "Sign in to continue" modal. */
  readonly compact = input(false, { transform: booleanAttribute });

  protected readonly view = computed(() => {
    const status = this.auth.status();
    if (this.auth.recovering()) return 'recovery';
    if (status === 'loading') return 'loading';
    if (status === 'unconfigured') return 'unconfigured';
    return status === 'signedIn' ? 'signedIn' : 'signedOut';
  });

  protected readonly syncedLabel = computed(() => {
    const at = this.sync.lastSyncedAt();
    if (!at) return 'Not synced yet on this device.';
    const when = new Date(at).toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
    return `Last synced ${when}`;
  });

  protected async syncNow(): Promise<void> {
    await this.sync.syncNow();
    if (this.sync.status() === 'idle') this.toast.show('Library synced');
  }

  protected value(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected setCreating(on: boolean): void {
    this.creating.set(on);
    this.auth.clearMessages();
  }

  protected async signIn(event: Event): Promise<void> {
    event.preventDefault();
    const ok = this.creating()
      ? await this.auth.signUp(this.email(), this.password())
      : await this.auth.signIn(this.email(), this.password());
    if (!ok) return;
    this.password.set('');
    if (this.auth.signedIn()) this.toast.show('Signed in');
    else if (this.creating()) this.creating.set(false);
  }

  protected async saveNewPassword(event: Event): Promise<void> {
    event.preventDefault();
    if (await this.auth.setNewPassword(this.password())) {
      this.password.set('');
      this.toast.show('Password updated');
    }
  }

  protected async resetPassword(): Promise<void> {
    await this.auth.resetPassword(this.email());
  }

  protected async signOut(): Promise<void> {
    if (await this.auth.signOut()) this.toast.show('Signed out');
  }
}
