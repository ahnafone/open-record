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
  /**
   * True when this build can download and install updates itself (Windows NSIS
   * install, or a Linux AppImage). False for .deb, macOS, and dev runs.
   */
  canSelfUpdate: boolean;
  /** Human-readable last failure, never a token or secret. */
  error: string | null;
}

/** Result of a mutating desktop action. */
export type ActionResult = { ok: true; status: DesktopStatus } | { ok: false; error: string };

/** Electron auto-update surface (`window.openRecordDesktop.updates`). */
export interface DesktopUpdatesBridge {
  /** True when this build can self-update (see `DesktopStatus.canSelfUpdate`). */
  supported(): Promise<boolean>;
  /** Check GitHub via electron-updater and download the newer build. Rejects with a readable message. */
  download(): Promise<void>;
  /** Quit, install the downloaded update, and relaunch. Stops the local server first. */
  install(): Promise<void>;
  /** Download progress 0..1. Returns an unsubscribe function. */
  onProgress(listener: (fraction: number) => void): () => void;
  /** Fired once the update is fully downloaded. Returns an unsubscribe function. */
  onDownloaded(listener: () => void): () => void;
  /** Why the previous install did not take effect, or null. Reported once per failure. */
  installError(): Promise<string | null>;
}

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
  updates: DesktopUpdatesBridge;
}

/**
 * IPC channel names. Namespaced and private: the Angular app never sees them,
 * only the methods exposed through the context bridge. `updatesProgress` and
 * `updatesDownloaded` are main-to-renderer events, not invokable handlers.
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
  updatesSupported: 'open-record:desktop:updates-supported',
  updatesDownload: 'open-record:desktop:updates-download',
  updatesInstall: 'open-record:desktop:updates-install',
  updatesProgress: 'open-record:desktop:updates-progress',
  updatesDownloaded: 'open-record:desktop:updates-downloaded',
  updatesInstallError: 'open-record:desktop:updates-install-error',
} as const;

export type DesktopChannel = (typeof DESKTOP_CHANNELS)[keyof typeof DESKTOP_CHANNELS];
