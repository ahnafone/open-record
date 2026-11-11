import { InjectionToken } from '@angular/core';

/**
 * Contract for in-app updates. Types and the platform port only: the logic
 * lives in `UpdateStore` (update.store.ts); platform adapters live in the app
 * (`apps/app/src/app/update-platform*.ts`).
 */

/** A published GitHub release newer than the running build. */
export interface UpdateRelease {
  /** Plain semver without the leading `v` (e.g. `0.0.5` or `0.0.5-beta.1`). */
  version: string;
  /** Release page (used for notify-only platforms). */
  url: string;
  /** Release notes (markdown/plain text body of the release); may be empty. */
  notes: string;
  /** Direct download URL of the Android `.apk` asset, or null when absent. */
  apkUrl: string | null;
  /** SHA-256 hex digest of the APK when GitHub reports one, else null. */
  apkSha256: string | null;
  /**
   * Download URL of the checksum file for the APK: the release asset named
   * `SHA256SUMS`, else `<apk asset name>.sha256`. Null when neither exists.
   * The store does not fetch it; the Android plugin does.
   */
  apkChecksumUrl: string | null;
  prerelease: boolean;
}

/**
 * What the current platform can do about an update. Implemented by the app:
 *  - Electron (Windows NSIS / Linux AppImage): `canSelfUpdate = true`
 *    (background download, restart to install).
 *  - Electron .deb / macOS (unsigned): notify only (both flags false).
 *  - Android: `canInstallApk = true` (download in app, then system installer).
 *  - iOS / web: no platform (`null`), notify only or nothing.
 */
export interface UpdatePlatform {
  readonly kind: 'electron' | 'android';
  /** Installed version, plain semver; null when it cannot be determined. */
  currentVersion(): Promise<string | null>;
  /** Updates download in the background and install on restart (Electron). */
  readonly canSelfUpdate: boolean;
  /** Updates download in app and hand off to the system installer (Android). */
  readonly canInstallApk: boolean;
  /**
   * Start downloading `release`.
   *  - Electron: resolves once the download has started/finished; completion is
   *    signalled through `onDownloaded`.
   *  - Android: downloads the APK, verifies the SHA-256 when given, then
   *    launches the system installer (asking for "install unknown apps"
   *    permission first if needed). Resolves after the installer was launched;
   *    rejects with a readable message on failure or missing permission.
   */
  download(release: UpdateRelease): Promise<void>;
  /** Download progress, 0..1. Returns an unsubscribe function. */
  onProgress(listener: (fraction: number) => void): () => void;
  /** Fired once the update is fully downloaded and just needs a restart (Electron). */
  onDownloaded(listener: () => void): () => void;
  /** Quit and install the downloaded update (Electron). Android: not used. */
  restartAndInstall(): Promise<void>;
  /**
   * Message for a restart-and-install attempt that failed on the previous run
   * (Electron), else null. Read once at launch.
   */
  installError?(): Promise<string | null>;
}

/** Provided by the app on native/desktop builds; `null` elsewhere (web, iOS). */
export const UPDATE_PLATFORM = new InjectionToken<UpdatePlatform | null>('UPDATE_PLATFORM', {
  factory: () => null,
});

export type UpdatePhase = 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error';

/** What the sidebar About item should show. */
export type UpdateNotice = 'none' | 'available' | 'ready';

/** GitHub repo the releases are read from. */
export const UPDATE_REPO = 'ahnafone/open-record';
