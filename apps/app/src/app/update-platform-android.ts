import { Capacitor, registerPlugin } from '@capacitor/core';
import type { UpdatePlatform, UpdateRelease } from '@open-record/state';

/**
 * App-local native plugin (`AppUpdatePlugin.java`). Downloads the signed
 * release APK from GitHub into the app cache and launches the system installer.
 */
export interface AppUpdatePlugin {
  getVersion(): Promise<{ version: string }>;
  download(options: { url: string; sha256?: string; checksumUrl?: string }): Promise<{ path: string }>;
  canInstall(): Promise<{ granted: boolean }>;
  openInstallSettings(): Promise<void>;
  install(): Promise<void>;
  addListener(
    event: 'progress',
    listener: (data: { fraction: number }) => void,
  ): Promise<{ remove(): Promise<void> }>;
}

const PLUGIN = 'AppUpdate';

const PERMISSION_MESSAGE = 'Allow Open Record to install apps, then tap Download and install again.';

/** The APK is never downloaded or installed without a published SHA-256 (the native side enforces it too). */
const NO_CHECKSUM_MESSAGE = 'No checksum published for this release; cannot verify the update.';

/** Android sideload updates. `null` on web, iOS, Electron, or a build without the plugin. */
export function createAndroidUpdatePlatform(): UpdatePlatform | null {
  if (Capacitor.getPlatform() !== 'android' || !Capacitor.isPluginAvailable(PLUGIN)) {
    return null;
  }
  const plugin = registerPlugin<AppUpdatePlugin>(PLUGIN);
  const progressListeners = new Set<(fraction: number) => void>();

  // One native listener for the app's lifetime; fan out to subscribers.
  void plugin
    .addListener('progress', (data) => {
      for (const listener of progressListeners) listener(data.fraction);
    })
    .catch(() => undefined);

  return {
    kind: 'android',
    canSelfUpdate: false,
    canInstallApk: true,

    async currentVersion() {
      try {
        const { version } = await plugin.getVersion();
        return version.replace(/^v/, '') || null;
      } catch {
        return null;
      }
    },

    async download(release: UpdateRelease) {
      if (!release.apkUrl) throw new Error('No APK attached to this release');
      if (!release.apkSha256 && !release.apkChecksumUrl) throw new Error(NO_CHECKSUM_MESSAGE);

      // Check the permission before downloading, so a user who has to visit
      // Settings does not sit through a download they cannot install yet.
      const { granted } = await plugin.canInstall();
      if (!granted) {
        await plugin.openInstallSettings();
        throw new Error(PERMISSION_MESSAGE);
      }

      await plugin.download({
        url: release.apkUrl,
        ...(release.apkSha256 ? { sha256: release.apkSha256 } : {}),
        ...(release.apkChecksumUrl ? { checksumUrl: release.apkChecksumUrl } : {}),
      });
      await plugin.install();
    },

    onProgress(listener) {
      progressListeners.add(listener);
      return () => {
        progressListeners.delete(listener);
      };
    },

    // Android never signals "downloaded, restart to install"; the installer takes over.
    onDownloaded() {
      return () => undefined;
    },

    // Not used on Android: the system installer replaces the app.
    async restartAndInstall() {
      return undefined;
    },
  };
}
