import type { AuthProjectConfig } from '@open-record/state';

/**
 * Optional build-time Supabase project for accounts. Leave null to let users
 * enter a project in Settings (or skip accounts entirely; the app works fully
 * without them). Set it to bake in your project, for example:
 *
 *   { url: 'https://<ref>.supabase.co', anonKey: '<anon public key>' }
 *   { url: 'http://192.168.1.20:54321', anonKey: '<from `supabase status`>' }
 *
 * The anon key is public by design (row-level security protects the data);
 * never put the service-role key or JWT secret here.
 */
export const SUPABASE_BUILD_CONFIG: AuthProjectConfig | null = null;
