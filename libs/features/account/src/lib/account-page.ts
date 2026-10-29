import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import {
  AuthStore,
  ImportStore,
  LibraryStore,
  PlayCountsStore,
  PlaylistsStore,
  SyncStore,
} from '@open-record/state';
import {
  OrButton,
  OrDialog,
  OrIcon,
  OrSectionHead,
  OrSpinner,
  OrToast,
} from '@open-record/ui';
import { AccountSection } from './account-section';
import { accountAge, formatWhen } from './account-format';
import { DeleteAccountDialog } from './delete-account-dialog';

/** Which form the shared auth status line belongs to. */
type Action = 'password' | 'email' | 'signOut' | 'delete';

/**
 * Account screen (`/account`). Signed out (or arriving from a password reset
 * link) it shows the sign-in form; signed in: profile, local stats and sync,
 * change password and email, sign out (here or everywhere) and delete account.
 */
@Component({
  selector: 'or-account-page',
  imports: [
    AccountSection,
    DeleteAccountDialog,
    NgTemplateOutlet,
    OrButton,
    OrIcon,
    OrSectionHead,
    OrSpinner,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (!auth.available) {
      <or-section-head heading="Account" />
      <p class="lede">Accounts are not part of this app. Everything works without one.</p>
    } @else if (!auth.signedIn() || auth.recovering()) {
      <or-account-section />
    } @else {
      <or-section-head heading="Profile" />
      <dl class="rows">
        <div class="row">
          <dt>Email</dt>
          <dd class="wrap">{{ profile()?.email || auth.user()?.email || '—' }}</dd>
        </div>
        @if (profile(); as p) {
          @if (p.createdAt) {
            <div class="row">
              <dt>Joined</dt>
              <dd>{{ when(p.createdAt) }}</dd>
            </div>
            <div class="row">
              <dt>Member for</dt>
              <dd>{{ age(p.createdAt) }}</dd>
            </div>
          }
          @if (p.lastSignInAt) {
            <div class="row">
              <dt>Last sign-in</dt>
              <dd>{{ when(p.lastSignInAt, true) }}</dd>
            </div>
          }
          <div class="row">
            <dt>Email confirmed</dt>
            <dd>
              @if (p.emailConfirmedAt) {
                <span class="ok"><or-icon name="check" [size]="16" />{{ when(p.emailConfirmedAt) }}</span>
              } @else {
                <span class="warn"><or-icon name="alert" [size]="16" />Not yet</span>
              }
            </dd>
          </div>
        }
      </dl>
      @if (!profile()) {
        <p class="status" role="status">
          @if (profileLoading()) {
            <span class="muted"><or-spinner [size]="14" />Loading account details…</span>
          } @else {
            <span class="muted">More account details appear when you are online.</span>
          }
        </p>
      }

      <or-section-head heading="Your music" />
      <dl class="rows">
        <div class="row">
          <dt>Records in library</dt>
          <dd class="num">{{ stats().records }}</dd>
        </div>
        <div class="row">
          <dt>Playlists</dt>
          <dd class="num">{{ stats().playlists }}</dd>
        </div>
        <div class="row">
          <dt>Tracks in playlists</dt>
          <dd class="num">{{ stats().playlistTracks }}</dd>
        </div>
        @if (sync.available) {
          <div class="row">
            <dt>Last sync</dt>
            <dd>{{ when(sync.lastSyncedAt(), true) || 'Not yet on this device' }}</dd>
          </div>
        }
      </dl>
      @if (sync.available) {
        <p class="status" role="status" aria-live="polite">
          @switch (sync.status()) {
            @case ('syncing') {
              <span class="muted"><or-spinner [size]="14" />Syncing your library…</span>
            }
            @case ('error') {
              <span class="bad"><or-icon name="alert" [size]="14" />{{ sync.error() }}</span>
            }
            @default {
              <span class="muted">Library and playlists sync across your devices (not audio files).</span>
            }
          }
        </p>
        <or-button
          block
          [disabled]="auth.busy() || sync.status() === 'syncing'"
          (click)="syncNow()"
          >Sync now</or-button
        >
      }

      <or-section-head heading="Password" />
      <form class="form" novalidate (submit)="changePassword($event)">
        <label class="field-label" for="or-acct-current-password">Current password</label>
        <div class="pw">
          <input
            id="or-acct-current-password"
            class="input"
            [type]="showPassword() ? 'text' : 'password'"
            autocomplete="current-password"
            autocapitalize="off"
            spellcheck="false"
            [attr.aria-invalid]="action() === 'password' && auth.error() ? 'true' : null"
            [attr.aria-describedby]="action() === 'password' ? 'or-acct-status' : null"
            [value]="currentPassword()"
            (input)="currentPassword.set(value($event))"
          />
          <button
            type="button"
            class="pw-toggle"
            [attr.aria-label]="showPassword() ? 'Hide passwords' : 'Show passwords'"
            [attr.aria-pressed]="showPassword()"
            (click)="showPassword.set(!showPassword())"
          >
            <or-icon [name]="showPassword() ? 'eye-off' : 'eye'" [size]="20" />
          </button>
        </div>
        <label class="field-label" for="or-acct-new-password">New password</label>
        <input
          id="or-acct-new-password"
          class="input"
          [type]="showPassword() ? 'text' : 'password'"
          autocomplete="new-password"
          autocapitalize="off"
          spellcheck="false"
          [attr.aria-invalid]="action() === 'password' && auth.error() ? 'true' : null"
          [attr.aria-describedby]="action() === 'password' ? 'or-acct-status' : null"
          [value]="password()"
          (input)="password.set(value($event))"
        />
        <label class="field-label" for="or-acct-confirm-password">Confirm new password</label>
        <input
          id="or-acct-confirm-password"
          class="input"
          [type]="showPassword() ? 'text' : 'password'"
          autocomplete="new-password"
          autocapitalize="off"
          spellcheck="false"
          [attr.aria-invalid]="mismatch() ? 'true' : null"
          [value]="confirmPassword()"
          (input)="confirmPassword.set(value($event))"
        />
        <div class="actions">
          <or-button type="submit" [disabled]="auth.busy() || !canChangePassword()"
            >Change password</or-button
          >
        </div>
        @if (action() === 'password') {
          <ng-container *ngTemplateOutlet="status" />
        } @else {
          <p class="status" aria-hidden="true"></p>
        }
      </form>

      <or-section-head heading="Email" />
      <form class="form" novalidate (submit)="changeEmail($event)">
        <label class="field-label" for="or-acct-new-email">New email</label>
        <input
          id="or-acct-new-email"
          class="input"
          type="email"
          inputmode="email"
          autocomplete="email"
          autocapitalize="off"
          spellcheck="false"
          [attr.aria-invalid]="action() === 'email' && auth.error() ? 'true' : null"
          [attr.aria-describedby]="action() === 'email' ? 'or-acct-status' : null"
          [value]="newEmail()"
          (input)="newEmail.set(value($event))"
        />
        <div class="actions">
          <or-button type="submit" [disabled]="auth.busy() || !newEmail().trim()"
            >Change email</or-button
          >
        </div>
        @if (action() === 'email') {
          <ng-container *ngTemplateOutlet="status" />
        } @else {
          <p class="status" aria-hidden="true"></p>
        }
      </form>

      <or-section-head heading="Sign out" />
      <div class="stack">
        <or-button block [disabled]="auth.busy()" (click)="signOut()">Sign out</or-button>
        <or-button block [disabled]="auth.busy()" (click)="signOutEverywhere()"
          >Sign out of all devices</or-button
        >
      </div>
      @if (action() === 'signOut') {
        <ng-container *ngTemplateOutlet="status" />
      }

      <or-section-head heading="Delete account" />
      <p class="lede">
        Permanently delete your account and the library and playlists synced to
        it. Music saved on this device stays here.
      </p>
      <or-button variant="danger" block [disabled]="auth.busy()" (click)="openDelete()"
        >Delete account</or-button
      >
      @if (action() === 'delete') {
        <ng-container *ngTemplateOutlet="status" />
      }

      <or-delete-account-dialog
        [(open)]="deleteOpen"
        [email]="auth.user()?.email"
        [busy]="auth.busy()"
        (confirmed)="deleteAccount()"
      />
    }

    <ng-template #status>
      <p id="or-acct-status" class="status" role="status">
        @if (localError(); as e) {
          <span class="bad"><or-icon name="alert" [size]="14" />{{ e }}</span>
        } @else if (auth.error(); as e) {
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
    or-section-head:first-child {
      margin-top: var(--spacing-xs);
    }
    .lede {
      margin: var(--spacing-xs) 0 var(--spacing-md);
      font-size: 13px;
      line-height: 1.45;
      color: var(--color-muted);
    }
    .rows {
      display: grid;
      margin: 0 0 var(--spacing-sm);
    }
    .row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--spacing-md);
      min-block-size: var(--spacing-touch);
      border-bottom: 1px solid color-mix(in srgb, var(--color-border) 32%, transparent);
    }
    dt {
      flex: none;
      font-size: 13px;
      color: var(--color-muted);
    }
    dd {
      margin: 0;
      min-inline-size: 0;
      font-size: 14px;
      text-align: end;
    }
    .wrap {
      overflow-wrap: anywhere;
    }
    .num {
      font-variant-numeric: tabular-nums;
    }
    .ok,
    .warn,
    .bad,
    .muted {
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .warn,
    .muted {
      color: var(--color-muted);
    }
    .bad {
      color: var(--color-primary);
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
    .input:focus,
    .input[aria-invalid='true'] {
      border-color: var(--color-primary);
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
    .actions {
      display: grid;
      margin-top: var(--spacing-sm);
    }
    .stack {
      display: grid;
      gap: var(--spacing-sm);
    }
    /* Reserved status line so the forms do not jump. */
    .status {
      margin: var(--spacing-xs) 0 0;
      min-block-size: 18px;
      font-size: 12px;
      line-height: 1.5;
    }
    @media (prefers-reduced-motion: reduce) {
      .input {
        transition-duration: 1ms;
      }
    }
  `,
})
export class AccountPage {
  protected readonly auth = inject(AuthStore);
  protected readonly sync = inject(SyncStore);
  private readonly library = inject(LibraryStore);
  private readonly playlists = inject(PlaylistsStore);
  private readonly imports = inject(ImportStore);
  private readonly playCounts = inject(PlayCountsStore);
  private readonly dialog = inject(OrDialog);
  private readonly toast = inject(OrToast);

  protected readonly profile = this.auth.profile;
  protected readonly profileLoading = signal(false);
  protected readonly action = signal<Action | null>(null);
  protected readonly localError = signal<string | null>(null);
  protected readonly currentPassword = signal('');
  protected readonly password = signal('');
  protected readonly confirmPassword = signal('');
  protected readonly showPassword = signal(false);
  protected readonly newEmail = signal('');
  protected readonly deleteOpen = signal(false);

  /** Confirm is filled in but differs from the new password. */
  protected readonly mismatch = computed(
    () => !!this.confirmPassword() && this.password() !== this.confirmPassword(),
  );
  protected readonly canChangePassword = computed(
    () =>
      !!this.currentPassword() &&
      !!this.password() &&
      this.password() === this.confirmPassword(),
  );

  protected readonly stats = computed(() => {
    const lists = this.playlists.playlists();
    return {
      records: this.library.savedRecords().length,
      playlists: lists.length,
      playlistTracks: lists.reduce((n, p) => n + p.trackIds.length, 0),
    };
  });

  constructor() {
    this.auth.clearMessages();
    // Load profile details whenever a (different) account is signed in here.
    effect(() => {
      const id = this.auth.signedIn() ? this.auth.user()?.id : undefined;
      if (!id) return;
      untracked(() => void this.loadProfile());
    });
  }

  protected when(value: string | number | null | undefined, withTime = false): string {
    return formatWhen(value, withTime);
  }

  protected age(createdAt: string): string {
    return accountAge(createdAt);
  }

  protected value(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected async syncNow(): Promise<void> {
    await this.sync.syncNow();
    if (this.sync.status() === 'idle') this.toast.show('Library synced');
  }

  protected async changePassword(event: Event): Promise<void> {
    event.preventDefault();
    this.begin('password');
    if (this.password() !== this.confirmPassword()) {
      this.localError.set('The passwords do not match.');
      return;
    }
    // Always the verified path: the no-current-password one is for reset links only.
    if (await this.auth.changePassword(this.currentPassword(), this.password())) {
      this.currentPassword.set('');
      this.password.set('');
      this.confirmPassword.set('');
      this.toast.show('Password updated');
    }
  }

  protected async changeEmail(event: Event): Promise<void> {
    event.preventDefault();
    this.begin('email');
    if (await this.auth.updateEmail(this.newEmail())) this.newEmail.set('');
  }

  protected async signOut(): Promise<void> {
    this.begin('signOut');
    // Upload this session's plays before the account goes away.
    await this.playCounts.flush().catch(() => undefined);
    if (await this.auth.signOut()) this.toast.show('Signed out');
  }

  protected async signOutEverywhere(): Promise<void> {
    this.begin('signOut');
    const ok = await this.dialog.confirm({
      title: 'Sign out of all devices?',
      message:
        'You will be signed out here and on every other device. Music saved on your devices stays.',
      confirmLabel: 'Sign out everywhere',
    });
    if (!ok) return;
    // Upload this session's plays before the account goes away.
    await this.playCounts.flush().catch(() => undefined);
    if (await this.auth.signOutEverywhere()) this.toast.show('Signed out of all devices');
  }

  protected openDelete(): void {
    this.begin('delete');
    this.deleteOpen.set(true);
  }

  protected async deleteAccount(): Promise<void> {
    this.begin('delete');
    const deleted = await this.auth.deleteAccount();
    this.deleteOpen.set(false);
    if (!deleted) return;
    // The account is gone: drop this device's Spotify import data too.
    await this.imports.deleteImportData().catch(() => undefined);
    // and this device's play counts.
    await this.playCounts.clear().catch(() => undefined);
    this.toast.show('Account deleted');
  }

  private begin(action: Action): void {
    this.action.set(action);
    this.localError.set(null);
    this.auth.clearMessages();
  }

  private async loadProfile(): Promise<void> {
    this.profileLoading.set(true);
    try {
      await this.auth.loadProfile();
    } finally {
      this.profileLoading.set(false);
    }
  }
}
