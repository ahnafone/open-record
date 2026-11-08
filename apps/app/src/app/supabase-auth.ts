import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import {
  AuthPort,
  type AuthProfile,
  type AuthProjectConfig,
  type AuthUser,
} from '@open-record/state';
import type { Session, SupabaseClient, SupportedStorage } from '@supabase/supabase-js';

/** Preferences key for the last project the download server offered (offline start). */
const SERVER_PROJECT_KEY = 'openRecord.auth.serverProject';

/**
 * Where a project comes from when none is built in: the download server's
 * public `GET /app-config`. `serverUrl` resolves the saved (or same-origin)
 * server address, '' when none; `fetchConfig` rejects when the server cannot
 * be reached and resolves null when it has no accounts set up.
 */
export interface ServerProjectSource {
  serverUrl(): Promise<string>;
  fetchConfig(serverUrl: string): Promise<AuthProjectConfig | null>;
}

/**
 * Supabase session storage on Capacitor Preferences (SharedPreferences /
 * UserDefaults on native, localStorage on web), kept apart from the app's
 * settings collection so tokens never land in exports or the settings store.
 */
const sessionStorage: SupportedStorage = {
  getItem: async (key) => (await Preferences.get({ key })).value,
  setItem: (key, value) => Preferences.set({ key, value }),
  removeItem: (key) => Preferences.remove({ key }),
};

function toUser(session: Session | null): AuthUser | null {
  return session ? { id: session.user.id, email: session.user.email } : null;
}

function isProject(value: unknown): value is AuthProjectConfig {
  const v = value as Partial<AuthProjectConfig> | null;
  return typeof v?.url === 'string' && typeof v.anonKey === 'string' && !!v.url && !!v.anonKey;
}

/**
 * Access token of an invite link in the URL (web only): `type=invite` with both
 * tokens present, else null. A bare `type=invite` proves nothing on its own.
 */
function inviteAccessToken(): string | null {
  if (Capacitor.isNativePlatform() || typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  if (params.get('type') !== 'invite' || !params.get('refresh_token')) return null;
  return params.get('access_token') || null;
}

function validUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

/** Supabase errors as user-facing text (network failures get a plain message). */
function friendly(error: { message?: string; name?: string; status?: number }): Error {
  if (error.name === 'AuthRetryableFetchError' || error.status === 0) {
    return new Error('Could not reach the account server. Check your connection.');
  }
  const message = error.message ?? '';
  if (/password should (contain|be at least)/i.test(message)) {
    return new Error(
      'Pick a stronger password: use upper and lower case letters, a number and a symbol (like ! or @).',
    );
  }
  return new Error(message || 'Something went wrong. Try again.');
}

/**
 * `AuthPort` over `@supabase/supabase-js`. The library is loaded on first use,
 * so builds without a project never download it. The project is the build
 * constant, else what the download server offers (cached per server URL and
 * remembered for offline starts; re-fetched when the server URL changes).
 * Users never type it. Works the same
 * against a hosted project or the local Supabase CLI stack (`supabase start`).
 *
 * Email + password only for now: OAuth providers need a deep-link redirect
 * on Android/iOS (`@capacitor/app`), which is a follow-up.
 */
export class SupabaseAuth extends AuthPort {
  private client: SupabaseClient | null = null;
  private clientFor: string | null = null;
  /** The client being created for a project id; replaced or cleared by a newer request or a drop. */
  private building: { id: string; promise: Promise<SupabaseClient | null> } | null = null;
  /** Project id of the most recent `ensureClient` (null when none); lets a build notice it was overtaken. */
  private requestedId: string | null = null;
  private listeners = new Set<(user: AuthUser | null) => void>();
  private recoveryListeners = new Set<() => void>();
  /** A reset link was opened before anyone listened (replayed on subscribe). */
  private recoveryPending = false;
  private stopListening?: () => void;
  /** In-flight `refreshAccessToken` (shared by concurrent callers). */
  private refreshing: Promise<string | null> | null = null;

  /** Fetched server project per server URL (failures are not cached, so they retry). */
  private serverProjects = new Map<string, Promise<AuthProjectConfig | null>>();

  constructor(
    private readonly buildConfig: AuthProjectConfig | null,
    private readonly server?: ServerProjectSource,
  ) {
    super();
  }

  async activeProject(): Promise<AuthProjectConfig | null> {
    if (this.buildConfig) return this.buildConfig;
    if (!this.server) return null;
    const serverUrl = (await this.server.serverUrl()).trim();
    if (!serverUrl) return null;
    let pending = this.serverProjects.get(serverUrl);
    if (!pending) {
      pending = this.loadServerProject(serverUrl);
      this.serverProjects.set(serverUrl, pending);
    }
    return pending;
  }

  async restore(): Promise<AuthUser | null> {
    const client = await this.ensureClient();
    if (!client) return null;
    const { data, error } = await client.auth.getSession();
    if (error) throw friendly(error);
    return toUser(data.session);
  }

  onChange(listener: (user: AuthUser | null) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onRecovery(listener: () => void): () => void {
    this.recoveryListeners.add(listener);
    if (this.recoveryPending) {
      this.recoveryPending = false;
      listener();
    }
    return () => this.recoveryListeners.delete(listener);
  }

  async updatePassword(password: string): Promise<void> {
    const client = await this.requireClient();
    const { error } = await client.auth.updateUser({ password });
    if (error) throw friendly(error);
  }

  async verifyPassword(password: string): Promise<void> {
    const client = await this.requireClient();
    const { data: current } = await client.auth.getSession();
    const user = current.session?.user;
    if (!user?.email) throw new Error('Sign in to change your password.');
    // Re-authenticate as the signed-in account. A wrong password leaves the
    // existing session untouched; a match just refreshes it.
    const { data, error } = await client.auth.signInWithPassword({
      email: user.email,
      password,
    });
    if (error) {
      if (error.code === 'invalid_credentials' || /invalid login credentials/i.test(error.message))
        throw new Error('Current password is incorrect.');
      throw friendly(error);
    }
    if (data.user.id !== user.id) throw new Error('Current password is incorrect.');
  }

  async signUp(email: string, password: string): Promise<{ needsConfirmation: boolean }> {
    const client = await this.requireClient();
    const { data, error } = await client.auth.signUp({ email, password });
    if (error) throw friendly(error);
    return { needsConfirmation: !data.session };
  }

  async signIn(email: string, password: string): Promise<AuthUser> {
    const client = await this.requireClient();
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw friendly(error);
    return { id: data.user.id, email: data.user.email };
  }

  async signOut(): Promise<void> {
    const client = await this.ensureClient();
    if (!client) return;
    // Local scope: always clears this device, even when offline.
    const { error } = await client.auth.signOut({ scope: 'local' });
    if (error) throw friendly(error);
  }

  async resetPassword(email: string): Promise<void> {
    const client = await this.requireClient();
    // Web: come back to this page (must be an allowed Redirect URL in Supabase,
    // otherwise Supabase falls back to its Site URL).
    const redirectTo = Capacitor.isNativePlatform() ? undefined : `${window.location.origin}/`;
    const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo });
    if (error) throw friendly(error);
  }

  async profile(): Promise<AuthProfile | null> {
    const client = await this.ensureClient();
    if (!client) return null;
    // getUser asks the server (not the cached session), so dates are current.
    const { data, error } = await client.auth.getUser();
    if (error) throw friendly(error);
    const user = data.user;
    if (!user) return null;
    return {
      id: user.id,
      email: user.email,
      createdAt: user.created_at || undefined,
      lastSignInAt: user.last_sign_in_at || undefined,
      emailConfirmedAt: user.email_confirmed_at || undefined,
    };
  }

  async updateEmail(email: string): Promise<void> {
    const client = await this.requireClient();
    const emailRedirectTo = Capacitor.isNativePlatform() ? undefined : `${window.location.origin}/`;
    const { error } = await client.auth.updateUser({ email }, { emailRedirectTo });
    if (error) throw friendly(error);
  }

  async signOutEverywhere(): Promise<void> {
    const client = await this.requireClient();
    // Global scope revokes every refresh token of this user (needs the server).
    const { error } = await client.auth.signOut({ scope: 'global' });
    if (error) throw friendly(error);
  }

  async deleteAccount(): Promise<void> {
    const client = await this.requireClient();
    // SQL function (security definer) deletes only the caller's own account.
    const { error } = await client.rpc('delete_own_account');
    if (error?.code === 'PGRST202')
      throw new Error('Deleting accounts is not set up on this server yet.');
    if (error) throw friendly(error);
    // The user is gone server-side; clear this device's session regardless.
    await client.auth.signOut({ scope: 'local' }).catch(() => undefined);
  }

  async accessToken(): Promise<string | null> {
    const client = await this.ensureClient();
    if (!client) return null;
    const { data } = await client.auth.getSession();
    return data.session?.access_token ?? null;
  }

  /**
   * Refresh the Supabase session. Concurrent callers share one request (the
   * session transport may get several 401s at once). Null when signed out or
   * the refresh fails; this never prompts the user.
   */
  refreshAccessToken(): Promise<string | null> {
    this.refreshing ??= this.refreshSession()
      .catch(() => null)
      .finally(() => {
        this.refreshing = null;
      });
    return this.refreshing;
  }

  private async refreshSession(): Promise<string | null> {
    const client = await this.ensureClient();
    if (!client) return null;
    const { data: current } = await client.auth.getSession();
    if (!current.session) return null;
    const { data, error } = await client.auth.refreshSession();
    if (error) return null;
    return data.session?.access_token ?? null;
  }

  /** The active project's client (shared with account sync), or null when none is set. */
  async sharedClient(): Promise<SupabaseClient | null> {
    return this.ensureClient();
  }

  private async loadServerProject(serverUrl: string): Promise<AuthProjectConfig | null> {
    const server = this.server;
    if (!server) return null;
    try {
      const fetched = await server.fetchConfig(serverUrl);
      const project = fetched && validUrl(fetched.url) && fetched.anonKey ? fetched : null;
      if (project)
        await Preferences.set({
          key: SERVER_PROJECT_KEY,
          value: JSON.stringify({ server: serverUrl, ...project }),
        });
      else await Preferences.remove({ key: SERVER_PROJECT_KEY });
      return project;
    } catch {
      // Unreachable server: forget the attempt (retry next time) and fall
      // back to what this server offered before, so a saved session restores offline.
      this.serverProjects.delete(serverUrl);
      return this.rememberedProject(serverUrl);
    }
  }

  private async rememberedProject(serverUrl: string): Promise<AuthProjectConfig | null> {
    try {
      const { value } = await Preferences.get({ key: SERVER_PROJECT_KEY });
      const parsed = value ? (JSON.parse(value) as Partial<AuthProjectConfig> & { server?: unknown }) : null;
      if (parsed?.server !== serverUrl || !isProject(parsed)) return null;
      return {
        url: parsed.url,
        anonKey: parsed.anonKey,
        ...(typeof parsed.turnstileSiteKey === 'string' && parsed.turnstileSiteKey
          ? { turnstileSiteKey: parsed.turnstileSiteKey }
          : {}),
      };
    } catch {
      return null;
    }
  }

  private async requireClient(): Promise<SupabaseClient> {
    const client = await this.ensureClient();
    if (!client) throw new Error('Accounts are not set up on this server.');
    return client;
  }

  private async ensureClient(): Promise<SupabaseClient | null> {
    // The one project read per call (a server read may be a network fetch).
    const project = await this.activeProject();
    if (!project) {
      this.requestedId = null;
      this.dropClient();
      return null;
    }
    const id = `${project.url}\n${project.anonKey}`;
    this.requestedId = id;
    if (this.client && this.clientFor === id) return this.client;
    // Concurrent callers for the same project share one in-flight build. A
    // request for a different project replaces it; the replaced build installs nothing.
    let attempt = this.building;
    if (attempt?.id !== id) {
      const next = { id } as { id: string; promise: Promise<SupabaseClient | null> };
      next.promise = this.buildClient(next, project);
      this.building = next;
      attempt = next;
    }
    const client = await attempt.promise;
    // Superseded while loading (another project won, or the client was dropped): ask again.
    return client ?? this.ensureClient();
  }

  /**
   * Creates and installs the client for `attempt` (the project `ensureClient`
   * just read; no second server read), or returns null when the attempt is
   * superseded. Staleness is a cheap in-memory check: this build must still be
   * the current one and the latest request must still be for its project. The
   * checks and the install run with no await between them, so a stale build
   * never installs or replaces a client. A failure clears the attempt, so the
   * next call retries instead of replaying it.
   */
  private async buildClient(attempt: { id: string }, project: AuthProjectConfig): Promise<SupabaseClient | null> {
    try {
      const { createClient } = await import('@supabase/supabase-js');
      if (this.building !== attempt) return null;
      if (this.requestedId !== attempt.id) {
        // A newer request wants another project (or none): this build is stale.
        this.building = null;
        return null;
      }

      // Tear down the old client before the new one exists: two GoTrueClients must
      // never share the session storage key during init.
      this.teardownClient();
      // A reset link lands with recovery tokens in the URL; the library verifies
      // them, signs the user in and only then emits PASSWORD_RECOVERY (after this
      // listener is attached). Never trust a bare `type=recovery` in the URL: on a
      // signed-in device it would unlock "set password" without the current one.
      // An event fired before the store listens is replayed by `onRecovery`.
      // Invite links (`type=invite`) sign the user in with no PASSWORD_RECOVERY
      // event, so read the link's tokens from the URL before the client consumes
      // it. The flag is only honoured for the SIGNED_IN session that carries that
      // link's access token, so a forged hash cannot unlock "set password".
      // Native has no URL to read (detectSessionInUrl is web-only), so an
      // invite there is not detected and the user sets a password from Account.
      let inviteToken = inviteAccessToken();
      const client = createClient(project.url, project.anonKey, {
        auth: {
          storage: sessionStorage,
          persistSession: true,
          autoRefreshToken: true,
          // Web: pick up the session from email confirmation / reset links.
          // Native has no URL to read until deep links are added.
          detectSessionInUrl: !Capacitor.isNativePlatform(),
        },
      });
      this.client = client;
      this.clientFor = attempt.id;
      this.building = null;
      const { data } = client.auth.onAuthStateChange((event, session) => {
        if (event === 'PASSWORD_RECOVERY') this.notifyRecovery();
        // An invite signs the user in: the first sign-in from that link asks for a password.
        if (inviteToken && event === 'SIGNED_IN' && session?.access_token === inviteToken) {
          inviteToken = null;
          this.notifyRecovery();
        }
        const user = toUser(session);
        for (const listener of this.listeners) listener(user);
      });
      this.stopListening = () => data.subscription.unsubscribe();
      return client;
    } catch (error) {
      if (this.building === attempt) this.building = null;
      throw error;
    }
  }

  private notifyRecovery(): void {
    if (!this.recoveryListeners.size) this.recoveryPending = true;
    for (const listener of this.recoveryListeners) listener();
  }

  /** Forget the active client and any build still in flight (its result is ignored). */
  private dropClient(): void {
    this.building = null;
    this.teardownClient();
  }

  private teardownClient(): void {
    const client = this.client;
    this.stopListening?.();
    this.stopListening = undefined;
    this.client = null;
    this.clientFor = null;
    if (!client) return;
    // Sessions are stored per project, so switching servers (or going offline)
    // never signs out; the old client just stops refreshing.
    client.auth.stopAutoRefresh().catch(() => undefined);
  }
}
