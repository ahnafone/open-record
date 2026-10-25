import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  linkedSignal,
  signal,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { AuthStore } from '@open-record/state';
import { OrButton, OrIcon, OrSectionHead, OrSpinner, OrToast } from '@open-record/ui';

/**
 * Settings "Account" section: optional Supabase sign-in. Shown only when the
 * app is built with accounts (an AuthPort). Without a project the app stays
 * fully usable; this section explains that and lets the user add one.
 */
@Component({
  selector: 'or-account-section',
  imports: [NgTemplateOutlet, OrButton, OrIcon, OrSectionHead, OrSpinner],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <or-section-head heading="Account" />
    <p class="lede">
      Accounts are optional. Everything works on this device without one;
      signing in prepares your library for syncing across devices.
    </p>

    @switch (view()) {
      @case ('loading') {
        <p class="status" role="status">
          <span class="muted"><or-spinner [size]="14" />Checking your account…</span>
        </p>
      }
      @case ('project') {
        <form class="form" (submit)="saveProject($event)">
          <label class="field-label" for="or-auth-url">Supabase project URL</label>
          <input
            id="or-auth-url"
            class="input"
            type="url"
            inputmode="url"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
            placeholder="https://xyz.supabase.co"
            aria-describedby="or-auth-status"
            [attr.aria-invalid]="auth.error() ? 'true' : null"
            [value]="projectUrl()"
            (input)="projectUrl.set(value($event))"
          />
          <label class="field-label" for="or-auth-key">Anon key</label>
          <input
            id="or-auth-key"
            class="input"
            type="password"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
            aria-describedby="or-auth-status"
            [attr.aria-invalid]="auth.error() ? 'true' : null"
            [value]="projectKey()"
            (input)="projectKey.set(value($event))"
          />
          <div class="actions">
            <or-button
              type="submit"
              [disabled]="auth.busy() || !projectUrl().trim() || !projectKey().trim()"
              >Save project</or-button
            >
            @if (auth.project()) {
              <or-button [disabled]="auth.busy()" (click)="editingProject.set(false)"
                >Cancel</or-button
              >
            }
          </div>
          <ng-container *ngTemplateOutlet="status" />
        </form>
        <p class="note">
          Use your hosted Supabase project or a local one from the Supabase
          CLI. Find both values under Project Settings, API.
        </p>
        @if (auth.project()) {
          <button
            type="button"
            class="text-link"
            [disabled]="auth.busy()"
            (click)="removeProject()"
          >
            Stop using accounts on this device
          </button>
        }
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
          <input
            id="or-auth-password"
            class="input"
            type="password"
            [attr.autocomplete]="creating() ? 'new-password' : 'current-password'"
            aria-describedby="or-auth-status"
            [attr.aria-invalid]="auth.error() ? 'true' : null"
            [value]="password()"
            (input)="password.set(value($event))"
          />
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
          @if (!auth.projectLocked) {
            <button type="button" class="text-link" (click)="editingProject.set(true)">
              Change project
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
        <or-button block [disabled]="auth.busy()" (click)="signOut()">Sign out</or-button>
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
  private readonly toast = inject(OrToast);

  protected readonly email = signal('');
  protected readonly password = signal('');
  protected readonly creating = signal(false);
  protected readonly editingProject = signal(false);
  protected readonly projectUrl = linkedSignal(() => this.auth.project()?.url ?? '');
  protected readonly projectKey = linkedSignal(() => this.auth.project()?.anonKey ?? '');

  protected readonly view = computed(() => {
    const status = this.auth.status();
    if (status === 'loading') return 'loading';
    if (status === 'unconfigured' || (this.editingProject() && !this.auth.projectLocked))
      return 'project';
    return status === 'signedIn' ? 'signedIn' : 'signedOut';
  });

  protected value(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected setCreating(on: boolean): void {
    this.creating.set(on);
    this.auth.clearMessages();
  }

  protected async saveProject(event: Event): Promise<void> {
    event.preventDefault();
    const ok = await this.auth.setProject({ url: this.projectUrl(), anonKey: this.projectKey() });
    if (ok) {
      this.editingProject.set(false);
      this.toast.show('Account project saved');
    }
  }

  protected async removeProject(): Promise<void> {
    if (await this.auth.setProject(null)) {
      this.editingProject.set(false);
      this.toast.show('Accounts turned off on this device');
    }
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

  protected async resetPassword(): Promise<void> {
    await this.auth.resetPassword(this.email());
  }

  protected async signOut(): Promise<void> {
    if (await this.auth.signOut()) this.toast.show('Signed out');
  }
}
