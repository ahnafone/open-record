import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import { AuthPort, type AuthProjectConfig, type AuthUser } from '@open-record/state';
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
  private listeners = new Set<(user: AuthUser | null) => void>();
  private recoveryListeners = new Set<() => void>();
  /** A reset link was opened before anyone listened (replayed on subscribe). */
  private recoveryPending = false;
  private stopListening?: () => void;

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

  async accessToken(): Promise<string | null> {
    const client = await this.ensureClient();
    if (!client) return null;
    const { data } = await client.auth.getSession();
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
      return { url: parsed.url, anonKey: parsed.anonKey };
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
    const project = await this.activeProject();
    if (!project) {
      await this.dropClient();
      return null;
    }
    const id = `${project.url}\n${project.anonKey}`;
    if (this.client && this.clientFor === id) return this.client;
    await this.dropClient();

    const { createClient } = await import('@supabase/supabase-js');
    // A reset link lands with `type=recovery` in the URL; the library signs the
    // user in from it and emits PASSWORD_RECOVERY, which can fire before the
    // store listens, so remember it too.
    const fromResetLink =
      !Capacitor.isNativePlatform() && /[#?&]type=recovery\b/.test(window.location.href);
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
    const { data } = client.auth.onAuthStateChange((event, session) => {
      if (event === 'PASSWORD_RECOVERY') this.notifyRecovery();
      const user = toUser(session);
      for (const listener of this.listeners) listener(user);
    });
    this.stopListening = () => data.subscription.unsubscribe();
    this.client = client;
    this.clientFor = id;
    if (fromResetLink) this.notifyRecovery();
    return client;
  }

  private notifyRecovery(): void {
    if (!this.recoveryListeners.size) this.recoveryPending = true;
    for (const listener of this.recoveryListeners) listener();
  }

  private async dropClient(): Promise<void> {
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
