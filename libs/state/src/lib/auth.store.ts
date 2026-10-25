import { Injectable, computed, inject, signal } from '@angular/core';
import { AuthPort, type AuthProjectConfig, type AuthUser } from './ports';

/**
 * - `unavailable`: accounts are not built into this app (no AuthPort).
 * - `unconfigured`: no Supabase project set; the app runs anonymously.
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
  private started?: Promise<void>;
  private unsubscribe?: () => void;

  readonly status = this._status.asReadonly();
  readonly user = this._user.asReadonly();
  readonly signedIn = computed(() => this._status() === 'signedIn');
  /** An auth request is in flight. */
  readonly busy = this._busy.asReadonly();
  readonly error = this._error.asReadonly();
  readonly notice = this._notice.asReadonly();
  /** Accounts are built into this app. */
  readonly available = !!this.port;
  /** The project comes from the build and cannot be edited in Settings. */
  readonly projectLocked = !!this.port?.buildConfig;
  /** The active project (build-time or Settings-entered). */
  readonly project = this._project.asReadonly();

  /** Restore the session once (called at app start; safe to call again). */
  start(): Promise<void> {
    this.started ??= this.restore();
    return this.started;
  }

  /** Save or clear the Settings-entered project, then restore its session. */
  async setProject(config: AuthProjectConfig | null): Promise<boolean> {
    if (!this.port || this.projectLocked) return false;
    const next = config && { url: config.url.trim(), anonKey: config.anonKey.trim() };
    if (next && (!next.url || !next.anonKey)) {
      this._error.set('Enter the project URL and anon key.');
      return false;
    }
    return this.run(async (port) => {
      await port.setProjectConfig(next);
      this.started = this.restore();
      await this.started;
    });
  }

  async signUp(email: string, password: string): Promise<boolean> {
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

  clearMessages(): void {
    this._error.set(null);
    this._notice.set(null);
  }

  private async restore(): Promise<void> {
    const port = this.port;
    if (!port) return;
    this._status.set('loading');
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    try {
      const project = port.buildConfig ?? (await port.loadProjectConfig());
      this._project.set(project);
      if (!project) {
        this._user.set(null);
        this._status.set('unconfigured');
        return;
      }
      this.setUser(await port.restore());
      this.unsubscribe = port.onChange((user) => this.setUser(user));
    } catch {
      // A broken or unreachable project must never block the app.
      this._user.set(null);
      this._status.set(this._project() ? 'signedOut' : 'unconfigured');
    }
  }

  private setUser(user: AuthUser | null): void {
    this._user.set(user);
    this._status.set(user ? 'signedIn' : 'signedOut');
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
