import { Injectable, computed, inject, signal } from '@angular/core';
import { probeAdmin } from './access-api';
import { AuthPort, type AuthProfile, type AuthProjectConfig, type AuthUser } from './ports';

/**
 * - `unavailable`: accounts are not built into this app (no AuthPort).
 * - `unconfigured`: no Supabase project (none built in and the download
 *   server offers none); the app runs anonymously.
 * - `loading`: restoring the saved session.
 */
export type AuthStatus = 'unavailable' | 'unconfigured' | 'loading' | 'signedOut' | 'signedIn';

/** Supabase's default minimum password length. */
export const MIN_PASSWORD_LENGTH = 6;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Optional accounts. Everything else in the app works without signing in;
 * this only tracks who is signed in to the configured Supabase project.
 * Errors are user-facing messages; `notice` carries non-error outcomes
 * ("check your email").
 */
@Injectable({ providedIn: 'root' })
export class AuthStore {
  private readonly port = inject(AuthPort, { optional: true });

  private readonly _status = signal<AuthStatus>(this.port ? 'loading' : 'unavailable');
  private readonly _user = signal<AuthUser | null>(null);
  private readonly _busy = signal(false);
  private readonly _error = signal<string | null>(null);
  private readonly _notice = signal<string | null>(null);
  private readonly _project = signal<AuthProjectConfig | null>(null);
  private readonly _prompt = signal<string | null>(null);
  private readonly _recovering = signal(false);
  private readonly _profile = signal<AuthProfile | null>(null);
  private readonly _publicServer = signal(false);
  private readonly _isAdmin = signal(false);
  private adminProbe: Promise<void> = Promise.resolve();
  private readonly _accessDenied = signal(false);
  /** The user id the admin probe last ran for (one probe per sign-in). */
  private adminProbedFor: string | null = null;
  private started?: Promise<void>;
  private unsubscribe?: () => void;
  private unsubscribeRecovery?: () => void;

  readonly status = this._status.asReadonly();
  readonly user = this._user.asReadonly();
  readonly signedIn = computed(() => this._status() === 'signedIn');
  /** An auth request is in flight. */
  readonly busy = this._busy.asReadonly();
  readonly error = this._error.asReadonly();
  readonly notice = this._notice.asReadonly();
  /** Accounts are built into this app. */
  readonly available = !!this.port;
  /** The active project (build-time or from the download server). */
  readonly project = this._project.asReadonly();
  /** Accounts can be used right now (a project is available). */
  readonly accountsReady = computed(() => {
    const status = this._status();
    return status === 'signedIn' || status === 'signedOut' || status === 'loading';
  });
  /** Message of the open "Sign in to continue" prompt, or null when closed. */
  readonly signInPrompt = this._prompt.asReadonly();
  /** The user opened a password reset link and must choose a new password. */
  readonly recovering = this._recovering.asReadonly();
  /** Server details of the signed-in account, once `loadProfile` has run (null otherwise). */
  readonly profile = this._profile.asReadonly();
  /**
   * The app is connected to the public Open Record server: sign-up is closed
   * there (access is requested instead). Set by `SettingsStore`.
   */
  readonly publicServer = this._publicServer.asReadonly();
  /**
   * The signed-in account is the server's admin (probed once per sign-in on
   * the public server; false elsewhere, and whenever the probe fails).
   */
  readonly isAdmin = this._isAdmin.asReadonly();
  /**
   * The server refused the signed-in account's API calls with
   * `403 access-not-approved` (not approved, or revoked). Not an expired
   * session: nothing retries it. Cleared on sign-out or a different account.
   */
  readonly accessDenied = this._accessDenied.asReadonly();

  /** Restore the session once (called at app start; safe to call again). */
  start(): Promise<void> {
    this.started ??= this.restore();
    return this.started;
  }

  /** Re-resolve the project and restore its session (e.g. after the server URL changed). */
  refresh(): Promise<void> {
    if (!this.port) return Promise.resolve();
    this.started = this.restore();
    return this.started;
  }

  /**
   * Gate for account-only actions (liking, saving, importing). True when the
   * user may go ahead: signed in, or accounts are not set up at all (the app
   * then works anonymously). Otherwise opens the sign-in prompt and returns false.
   */
  requireAccount(message = 'Sign in to save music to your library.'): boolean {
    if (this.signedIn() || !this.accountsReady()) return true;
    this.promptSignIn(message);
    return false;
  }

  /** Open the "Sign in to continue" prompt (no-op when signed in or accounts are unavailable). */
  promptSignIn(message = 'Sign in to continue.'): void {
    if (this.signedIn() || !this.accountsReady()) return;
    this.clearMessages();
    this._prompt.set(message);
  }

  closeSignInPrompt(): void {
    this._prompt.set(null);
  }

  async signUp(email: string, password: string): Promise<boolean> {
    // The public server admits accounts by invitation only (see `AccessRequestService`).
    if (this._publicServer()) {
      this.clearMessages();
      this._error.set('Accounts on this server are by invitation. Request access instead.');
      return false;
    }
    if (!this.validate(email, password)) return false;
    return this.run(async (port) => {
      const { needsConfirmation } = await port.signUp(email.trim(), password);
      if (needsConfirmation)
        this._notice.set('Check your email to confirm your account, then sign in.');
    });
  }

  async signIn(email: string, password: string): Promise<boolean> {
    if (!this.validate(email, password)) return false;
    return this.run(async (port) => {
      this.setUser(await port.signIn(email.trim(), password));
    });
  }

  async signOut(): Promise<boolean> {
    return this.run(async (port) => {
      await port.signOut();
      this.setUser(null);
    });
  }

  /**
   * Reset-link recovery only: set a new password without the current one.
   * Refused unless the user arrived from a reset email (`recovering`).
   */
  async setNewPassword(password: string): Promise<boolean> {
    if (!this._recovering()) {
      this.clearMessages();
      this._error.set('Open the reset link from your email to set a new password.');
      return false;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      this._error.set(`Use at least ${MIN_PASSWORD_LENGTH} characters for the password.`);
      return false;
    }
    return this.run(async (port) => {
      await port.updatePassword(password);
      this._recovering.set(false);
      this._notice.set('Password updated.');
    });
  }

  /** Change the signed-in account's password; the current one must be correct. */
  async changePassword(current: string, next: string): Promise<boolean> {
    this.clearMessages();
    if (!this.signedIn()) {
      this._error.set('Sign in to change your password.');
      return false;
    }
    if (!current) {
      this._error.set('Enter your current password.');
      return false;
    }
    if (next.length < MIN_PASSWORD_LENGTH) {
      this._error.set(`Use at least ${MIN_PASSWORD_LENGTH} characters for the password.`);
      return false;
    }
    if (next === current) {
      this._error.set('Choose a new password that differs from the current one.');
      return false;
    }
    return this.run(async (port) => {
      await port.verifyPassword(current);
      await port.updatePassword(next);
      this._notice.set('Password updated.');
    });
  }

  /** Fetch the signed-in account's details (email, joined, last sign-in, confirmed). */
  async loadProfile(): Promise<AuthProfile | null> {
    if (!this.port || !this.signedIn()) return null;
    try {
      const profile = await this.port.profile();
      if (profile && profile.id === this._user()?.id) this._profile.set(profile);
      return profile;
    } catch {
      // Offline or the server is unreachable: keep what we had.
      return this._profile();
    }
  }

  /** Change the account's email; the project emails confirmation links. */
  async updateEmail(email: string): Promise<boolean> {
    const next = email.trim();
    if (!EMAIL.test(next)) {
      this._error.set('Enter a valid email address.');
      return false;
    }
    if (next.toLowerCase() === this._user()?.email?.toLowerCase()) {
      this._error.set('That is already your email address.');
      return false;
    }
    return this.run(async (port) => {
      await port.updateEmail(next);
      this._notice.set('Check both inboxes to confirm the change.');
    });
  }

  /** Sign out on every device, including this one. */
  async signOutEverywhere(): Promise<boolean> {
    return this.run(async (port) => {
      await port.signOutEverywhere();
      this.setUser(null);
    });
  }

  /** Permanently delete the account and its synced data, then sign out here. */
  async deleteAccount(): Promise<boolean> {
    if (!this.signedIn()) return false;
    return this.run(async (port) => {
      await port.deleteAccount();
      this.setUser(null);
    });
  }

  async resetPassword(email: string): Promise<boolean> {
    if (!EMAIL.test(email.trim())) {
      this._error.set('Enter your email address.');
      return false;
    }
    return this.run(async (port) => {
      await port.resetPassword(email.trim());
      this._notice.set('If that email has an account, a reset link is on its way.');
    });
  }

  /** Current access token for authenticated requests, or null when signed out. */
  async accessToken(): Promise<string | null> {
    if (!this.port || !this.signedIn()) return null;
    try {
      return await this.port.accessToken();
    } catch {
      return null;
    }
  }

  /**
   * Force a token refresh after a rejected request (session sync retries a
   * `401` once). Null when signed out or the refresh fails; never prompts.
   */
  async refreshAccessToken(): Promise<string | null> {
    if (!this.port || !this.signedIn()) return null;
    try {
      return await this.port.refreshAccessToken();
    } catch {
      return null;
    }
  }

  clearMessages(): void {
    this._error.set(null);
    this._notice.set(null);
  }

  /**
   * Called by `SettingsStore` when the connection mode changes. On the public
   * server a signed-in account gets its admin probe (once per sign-in).
   */
  setPublicServer(on: boolean): void {
    if (this._publicServer() === on) return;
    this._publicServer.set(on);
    // Admin and denial are per server: a new connection starts clean.
    this.adminProbedFor = null;
    this._isAdmin.set(false);
    this._accessDenied.set(false);
    const user = this._user();
    if (on && user) this.checkAdmin(user.id);
  }

  /**
   * The server answered `403 access-not-approved` to this session's request.
   * Sessions call this instead of refreshing the token.
   */
  markAccessDenied(): void {
    if (this._user()) this._accessDenied.set(true);
  }

  private async restore(): Promise<void> {
    const port = this.port;
    if (!port) return;
    // A refresh keeps the current state visible (no flicker, no sync restart).
    const status = this._status();
    if (status !== 'signedIn' && status !== 'signedOut') this._status.set('loading');
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.unsubscribeRecovery?.();
    this.unsubscribeRecovery = port.onRecovery(() => {
      this._recovering.set(true);
      this._prompt.set(null);
    });
    try {
      const project = await port.activeProject();
      this._project.set(project);
      if (!project) {
        this._user.set(null);
        this._profile.set(null);
        this._prompt.set(null);
        this._status.set('unconfigured');
        return;
      }
      this.setUser(await port.restore());
      this.unsubscribe = port.onChange((user) => this.setUser(user));
    } catch {
      // A broken or unreachable project must never block the app.
      this._user.set(null);
      this._profile.set(null);
      this._status.set(this._project() ? 'signedOut' : 'unconfigured');
    }
  }

  private setUser(user: AuthUser | null): void {
    if (user?.id !== this._profile()?.id) this._profile.set(null);
    // Recovery belongs to the reset-link session; it ends when that session does.
    if (!user && this._user()) this._recovering.set(false);
    // Denial and admin status belong to one account; a token refresh keeps them.
    if (user?.id !== this._user()?.id) {
      this._accessDenied.set(false);
      this._isAdmin.set(false);
      this.adminProbedFor = null;
    }
    this._user.set(user);
    this._status.set(user ? 'signedIn' : 'signedOut');
    if (user) this._prompt.set(null);
    if (user) this.checkAdmin(user.id);
  }

  /** Admin probe for the public server: `list-access` answers 200 only for the admin. */
  private checkAdmin(userId: string): void {
    if (!this._publicServer() || this.adminProbedFor === userId) return;
    this.adminProbedFor = userId;
    this.adminProbe = this.probeAdminFor(userId);
  }

  /** Resolves once the admin probe for the current sign-in has finished (immediately when none is running). */
  whenAdminResolved(): Promise<void> {
    return this.adminProbe;
  }

  private async probeAdminFor(userId: string): Promise<void> {
    let project: AuthProjectConfig | null = null;
    let token: string | null = null;
    try {
      // The current project (the connection mode may have just changed).
      project = (await this.port?.activeProject()) ?? null;
      token = (await this.port?.accessToken()) ?? null;
    } catch {
      token = null;
    }
    if (!project || !token) {
      // Nothing to ask with yet: let a later sign-in or restore probe again.
      if (this.adminProbedFor === userId) this.adminProbedFor = null;
      return;
    }
    const admin = await probeAdmin(project, token);
    // Stale if the account changed or the public mode was switched off meanwhile.
    if (this._user()?.id === userId && this._publicServer()) this._isAdmin.set(admin);
  }

  private validate(email: string, password: string): boolean {
    if (!EMAIL.test(email.trim())) {
      this._error.set('Enter a valid email address.');
      return false;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      this._error.set(`Use at least ${MIN_PASSWORD_LENGTH} characters for the password.`);
      return false;
    }
    return true;
  }

  private async run(action: (port: AuthPort) => Promise<void>): Promise<boolean> {
    const port = this.port;
    if (!port || this._busy()) return false;
    this._busy.set(true);
    this.clearMessages();
    try {
      await action(port);
      return true;
    } catch (err) {
      this._error.set(
        err instanceof Error && err.message ? err.message : 'Something went wrong. Try again.',
      );
      return false;
    } finally {
      this._busy.set(false);
    }
  }
}
