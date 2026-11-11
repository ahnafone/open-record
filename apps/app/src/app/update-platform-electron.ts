import type { UpdatePlatform } from '@open-record/state';
import { getDesktopBridge } from './desktop-bridge';

/** What the main process reports about the running build. */
interface ElectronBuildInfo {
  version: string | null;
  canSelfUpdate: boolean;
}

const UNKNOWN_BUILD: ElectronBuildInfo = { version: null, canSelfUpdate: false };

/**
 * Electron (desktop) adapter for {@link UpdatePlatform}. The main process does
 * the GitHub check, download, and install through electron-updater; this only
 * forwards the calls over the preload bridge.
 *
 * Returns `null` when there is no desktop bridge or the bridge predates
 * auto-update (`updates` missing), so the rest of the app keeps working.
 *
 * `canSelfUpdate` is synchronous in the interface, but the main process reports
 * it through `getStatus()`, which is async. The factory starts that call right
 * away and caches the answer: until it resolves, `canSelfUpdate` is `false`.
 * Await `currentVersion()` (which resolves the same cached status) before
 * reading `canSelfUpdate`.
 */
export function createElectronUpdatePlatform(): UpdatePlatform | null {
  const bridge = getDesktopBridge();
  const updates = bridge?.updates;
  if (!bridge || !updates) return null;

  let build: ElectronBuildInfo = UNKNOWN_BUILD;
  const ready: Promise<ElectronBuildInfo> = bridge
    .getStatus()
    .then((status) => {
      build = {
        version: normalizeVersion(status.version),
        canSelfUpdate: status.canSelfUpdate === true,
      };
      return build;
    })
    .catch((): ElectronBuildInfo => UNKNOWN_BUILD);

  return {
    kind: 'electron',
    get canSelfUpdate(): boolean {
      return build.canSelfUpdate;
    },
    canInstallApk: false,
    async currentVersion(): Promise<string | null> {
      return (await ready).version;
    },
    // The release is not forwarded: the main process decides what to fetch from
    // its own GitHub feed, so no URL from the renderer reaches the updater.
    download: () => updates.download(),
    onProgress: (listener) => updates.onProgress(listener),
    onDownloaded: (listener) => updates.onDownloaded(listener),
    restartAndInstall: () => updates.install(),
    installError: () => updates.installError(),
  };
}

/** Plain semver without a leading `v`; null when the value is not a version. */
function normalizeVersion(raw: string | undefined): string | null {
  const version = (raw ?? '').trim().replace(/^v/, '');
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version) ? version : null;
}
