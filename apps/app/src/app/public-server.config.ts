/**
 * The public Open Record server ("Use the public Open Record server" in
 * Settings). Users who opt in point the app here instead of their own server,
 * and sign in (or request access) on it. Its `GET /app-config` supplies the
 * Supabase project and the Turnstile site key.
 *
 * Set to the deployed public server URL. Set it to '' to hide the option in a
 * build. There is no build-time env override: edit this one constant.
 */
export const PUBLIC_SERVER_URL = 'https://open-record.uttarasoftware.ca';
