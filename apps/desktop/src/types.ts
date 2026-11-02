/**
 * Contract shared by the Electron main process and the sandboxed preload.
 * Keep this file type-only at runtime (the IPC channel map below is the one
 * exception): the Angular side mirrors these shapes in `desktop-bridge.ts`.
 */

/** Lifecycle of the bundled Fastify child process. */
export type ServerState = 'starting' | 'ready' | 'error';

/** Everything the setup page may know about the desktop runtime. */
export interface DesktopStatus {
  server: ServerState;
  /** Always the fixed loopback origin (`http://127.0.0.1:47900`). */
  localUrl: string;
  lanEnabled: boolean;
  /** `http://<lan-ip>:47900` while the LAN server is ready, else null. */
  lanUrl: string | null;
  supabaseConfigured: boolean;
  /** Host only: never the project URL's full path, key or secret. */
  supabaseHost: string | null;
  dataDir: string;
  version: string;
  /** Human-readable last failure, never a token or secret. */
  error: string | null;
}

/** Result of a mutating desktop action. */
export type ActionResult = { ok: true; status: DesktopStatus } | { ok: false; error: string };

/** Input for {@link DesktopBridge.saveSupabaseConfig}. */
export interface SupabaseConfigInput {
  url: string;
  anonKey: string;
  jwtSecret?: string;
}

/** The complete preload surface (`window.openRecordDesktop`). */
export interface DesktopBridge {
  getStatus(): Promise<DesktopStatus>;
  getConnection(): Promise<{ url: string; token: string }>;
  saveSupabaseConfig(input: SupabaseConfigInput): Promise<ActionResult>;
  setLanEnabled(enabled: boolean): Promise<ActionResult>;
  restartServer(): Promise<ActionResult>;
  getPairing(): Promise<{ lanUrl: string | null }>;
  openGuide(): Promise<void>;
  openDataFolder(): Promise<void>;
}

/**
 * IPC channel names. Namespaced and private: the Angular app never sees them,
 * only the six methods exposed through the context bridge.
 */
export const DESKTOP_CHANNELS = {
  getStatus: 'open-record:desktop:get-status',
  getConnection: 'open-record:desktop:get-connection',
  saveSupabaseConfig: 'open-record:desktop:save-supabase-config',
  setLanEnabled: 'open-record:desktop:set-lan-enabled',
  restartServer: 'open-record:desktop:restart-server',
  getPairing: 'open-record:desktop:get-pairing',
  openGuide: 'open-record:desktop:open-guide',
  openDataFolder: 'open-record:desktop:open-data-folder',
} as const;

export type DesktopChannel = (typeof DESKTOP_CHANNELS)[keyof typeof DESKTOP_CHANNELS];
