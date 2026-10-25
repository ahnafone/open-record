import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import { AuthPort, type AuthProjectConfig, type AuthUser } from '@open-record/state';
import type { Session, SupabaseClient, SupportedStorage } from '@supabase/supabase-js';

/** Preferences key for the Settings-entered project (URL + public anon key). */
const PROJECT_KEY = 'openRecord.auth.project';

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

function checkUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Enter a valid project URL, like https://xyz.supabase.co');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('The project URL must start with https:// or http://');
  }
}

/** Supabase errors as user-facing text (network failures get a plain message). */
function friendly(error: { message?: string; name?: string; status?: number }): Error {
  if (error.name === 'AuthRetryableFetchError' || error.status === 0) {
    return new Error('Could not reach the account server. Check your connection and the project URL.');
  }
  return new Error(error.message || 'Something went wrong. Try again.');
}

/**
 * `AuthPort` over `@supabase/supabase-js`. The library is loaded on first use,
 * so builds without a configured project never download it. Works the same
 * against a hosted project or the local Supabase CLI stack (`supabase start`).
 *
 * Email + password only for now: OAuth providers need a deep-link redirect
 * on Android/iOS (`@capacitor/app`), which is a follow-up.
 */
export class SupabaseAuth extends AuthPort {
  private client: SupabaseClient | null = null;
  private clientFor: string | null = null;
  private listeners = new Set<(user: AuthUser | null) => void>();
  private stopListening?: () => void;

  constructor(readonly buildConfig: AuthProjectConfig | null) {
    super();
  }

  async loadProjectConfig(): Promise<AuthProjectConfig | null> {
    const { value } = await Preferences.get({ key: PROJECT_KEY });
    if (!value) return null;
    try {
      const parsed: unknown = JSON.parse(value);
      return isProject(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  async setProjectConfig(config: AuthProjectConfig | null): Promise<void> {
    if (config) checkUrl(config.url);
    await this.dropClient();
    if (config) await Preferences.set({ key: PROJECT_KEY, value: JSON.stringify(config) });
    else await Preferences.remove({ key: PROJECT_KEY });
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
    const { error } = await client.auth.resetPasswordForEmail(email);
    if (error) throw friendly(error);
  }

  async accessToken(): Promise<string | null> {
    const client = await this.ensureClient();
    if (!client) return null;
    const { data } = await client.auth.getSession();
    return data.session?.access_token ?? null;
  }

  private async activeProject(): Promise<AuthProjectConfig | null> {
    return this.buildConfig ?? (await this.loadProjectConfig());
  }

  private async requireClient(): Promise<SupabaseClient> {
    const client = await this.ensureClient();
    if (!client) throw new Error('Accounts are not set up. Add a Supabase project first.');
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
    const { data } = client.auth.onAuthStateChange((_event, session) => {
      const user = toUser(session);
      for (const listener of this.listeners) listener(user);
    });
    this.stopListening = () => data.subscription.unsubscribe();
    this.client = client;
    this.clientFor = id;
    return client;
  }

  private async dropClient(): Promise<void> {
    const client = this.client;
    this.stopListening?.();
    this.stopListening = undefined;
    this.client = null;
    this.clientFor = null;
    if (!client) return;
    // Forget the old project's session on this device (best effort).
    await client.auth.signOut({ scope: 'local' }).catch(() => undefined);
    client.auth.stopAutoRefresh().catch(() => undefined);
  }
}
