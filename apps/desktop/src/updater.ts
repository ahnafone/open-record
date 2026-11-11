import { app, type BrowserWindow } from 'electron';
import { autoUpdater, type UpdateCheckResult } from 'electron-updater';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DESKTOP_CHANNELS } from './types';

/**
 * Electron auto-update, main-process side. electron-updater only downloads and
 * installs: the update check itself is done by the renderer's UpdateStore,
 * which calls {@link DesktopUpdater.download} when it wants the build fetched.
 *
 * Unsigned builds: no `publisherName` is configured, so electron-updater does
 * not verify Windows code signatures. Do not add publisher config here.
 */

export interface DesktopUpdaterOptions {
  /** The app window, or null when none is open (progress events are dropped). */
  getWindow(): BrowserWindow | null;
  /**
   * Called before the installer starts. Stops the bundled local server so the
   * installer never races a running child process. Throws when an install
   * cannot start right now (for example another desktop action is running).
   */
  prepareInstall(): Promise<void>;
  /** Called when the install fails after {@link DesktopUpdaterOptions.prepareInstall}. Restarts the server. */
  resumeAfterFailedInstall(): Promise<void>;
}

export interface DesktopUpdater {
  supported(): boolean;
  download(): Promise<void>;
  install(): Promise<void>;
  /**
   * The readable reason the previous install did not take effect, or null.
   * Reported at most once: the install record is cleared when it is read.
   */
  installError(): Promise<string | null>;
}

/**
 * True only when electron-updater can replace this install in place:
 * a packaged Windows NSIS install, or a packaged Linux AppImage (APPIMAGE is
 * set by the AppImage runtime). False for .deb, macOS (unsigned) and dev runs.
 */
export function canSelfUpdate(): boolean {
  if (!app.isPackaged) return false;
  if (process.platform === 'win32') return true;
  if (process.platform === 'linux') return Boolean(process.env['APPIMAGE']);
  return false;
}

const NOT_SUPPORTED =
  'Automatic updates are not available in this build. Download the new version from the release page.';

/** Written before the installer starts, in userData; read on the next launch. */
const INSTALL_RECORD_FILE = 'update-install.json';

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

const NUMERIC_IDENTIFIER = /^\d+$/;

/**
 * Compares two plain semver strings. Returns null when either is not a version
 * this app produces. Pre-releases sort before their release. Pre-release
 * identifiers follow semver: numeric ones compare as numbers (`beta.9` < `beta.10`),
 * numeric ones rank below alphanumeric ones, and a shorter list ranks lower when
 * all earlier identifiers match. Mirrors libs/state/src/lib/update-version.ts.
 */
export function compareVersions(a: string, b: string): number | null {
  const x = VERSION_PATTERN.exec(a);
  const y = VERSION_PATTERN.exec(b);
  if (!x || !y) return null;
  for (let i = 1; i <= 3; i++) {
    const diff = Number(x[i]) - Number(y[i]);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  const preA = x[4];
  const preB = y[4];
  if (preA === preB) return 0;
  if (preA === undefined) return 1;
  if (preB === undefined) return -1;
  return comparePrerelease(preA.split('.'), preB.split('.'));
}

function comparePrerelease(a: string[], b: string[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const p = a[i];
    const q = b[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pNum = NUMERIC_IDENTIFIER.test(p);
    const qNum = NUMERIC_IDENTIFIER.test(q);
    if (pNum && qNum) return Number(p) - Number(q) < 0 ? -1 : 1;
    if (pNum !== qNum) return pNum ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

/**
 * The failure message for an install record, or null. A record means an install
 * was started for `target`; if the running version is still older, it did not
 * take effect. Exported for tests.
 */
export function installFailureFrom(raw: string | null, currentVersion: string): string | null {
  if (raw === null) return null;
  let record: unknown;
  try {
    record = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!record || typeof record !== 'object') return null;
  const target = (record as { target?: unknown }).target;
  if (typeof target !== 'string') return null;
  // Only a valid semver target is ever shown (compareVersions returns null otherwise).
  const order = compareVersions(currentVersion, target);
  if (order === null || order >= 0) return null;
  return `The update to ${target} did not install. Open Record is still on ${currentVersion}. Try the update again, or download the new version from the release page.`;
}

export function createDesktopUpdater(options: DesktopUpdaterOptions): DesktopUpdater {
  let configured = false;
  let downloaded = false;
  let downloadedVersion: string | null = null;
  let downloading: Promise<void> | null = null;
  let installing = false;

  function send(channel: string, payload?: unknown): void {
    const window = options.getWindow();
    if (!window || window.isDestroyed()) return;
    window.webContents.send(channel, payload);
  }

  /** Configures the electron-updater singleton once, on first real use. */
  function updater(): typeof autoUpdater {
    if (configured) return autoUpdater;
    configured = true;

    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowPrerelease = true;
    autoUpdater.allowDowngrade = false;

    autoUpdater.on('download-progress', (info) => {
      const fraction = Number.isFinite(info.percent) ? Math.min(1, Math.max(0, info.percent / 100)) : 0;
      send(DESKTOP_CHANNELS.updatesProgress, fraction);
    });
    autoUpdater.on('update-downloaded', (info) => {
      downloaded = true;
      downloadedVersion = info.version;
      send(DESKTOP_CHANNELS.updatesDownloaded);
    });
    autoUpdater.on('error', (err: Error) => {
      const message = readableUpdateError(err);
      console.error(`[desktop] ${message}`);
      if (installing) {
        installing = false;
        void options.resumeAfterFailedInstall().catch((restartErr: unknown) => {
          console.error(`[desktop] could not restart after a failed update: ${errorText(restartErr)}`);
        });
      }
    });
    return autoUpdater;
  }

  /** Runs electron-updater's check, turning a failure into a readable error. */
  async function checkOrThrow(): Promise<UpdateCheckResult | null> {
    try {
      return await updater().checkForUpdates();
    } catch (err) {
      throw new Error(readableUpdateError(err), { cause: err });
    }
  }

  /**
   * After a download finished, a newer release may have been published. Returns
   * the check when it offers a build different from the downloaded one; null
   * otherwise, including when the check fails (the current download is kept).
   */
  async function newerThanDownloaded(): Promise<UpdateCheckResult | null> {
    try {
      const check = await updater().checkForUpdates();
      if (!check?.isUpdateAvailable) return null;
      return check.updateInfo.version === downloadedVersion ? null : check;
    } catch (err) {
      console.error(`[desktop] could not check for a newer update: ${readableUpdateError(err)}`);
      return null;
    }
  }

  /** Downloads the update. `preChecked` skips the check when the caller already ran it. */
  async function runDownload(preChecked: UpdateCheckResult | null): Promise<void> {
    const check = preChecked ?? (await checkOrThrow());
    if (!check?.isUpdateAvailable) throw new Error('No newer version is available.');
    try {
      await updater().downloadUpdate();
      downloaded = true;
    } catch (err) {
      throw new Error(readableUpdateError(err), { cause: err });
    }
  }

  /** Fetches a newer build over an existing download; restores that download's state if the fetch fails. */
  async function runReplacement(newer: UpdateCheckResult): Promise<void> {
    const previousDownloaded = downloaded;
    const previousVersion = downloadedVersion;
    try {
      await runDownload(newer);
    } catch (err) {
      downloaded = previousDownloaded;
      downloadedVersion = previousVersion;
      throw err;
    }
  }

  return {
    supported(): boolean {
      return canSelfUpdate();
    },

    async download(): Promise<void> {
      if (!canSelfUpdate()) throw new Error(NOT_SUPPORTED);
      // A download already in flight is joined, not re-checked or restarted.
      if (downloading) return downloading;
      if (downloaded) {
        const newer = await newerThanDownloaded();
        // Another caller may have started a replacement while this check ran.
        if (downloading) return downloading;
        if (!newer) {
          // Already fetched and still the newest (or the check failed): repeat the
          // "downloaded" signal so the fresh renderer state catches up.
          send(DESKTOP_CHANNELS.updatesDownloaded);
          return;
        }
        // A newer build was published: fetch it. The stale download stays
        // recorded until the replacement succeeds, so a failed re-download
        // leaves install() working for the older file.
        downloading ??= runReplacement(newer).finally(() => {
          downloading = null;
        });
        return downloading;
      }
      downloading ??= runDownload(null).finally(() => {
        downloading = null;
      });
      return downloading;
    },

    async install(): Promise<void> {
      if (!canSelfUpdate()) throw new Error(NOT_SUPPORTED);
      if (!downloaded) throw new Error('No update has been downloaded yet.');
      if (downloading) throw new Error('An update is still downloading.');
      if (installing) return;

      installing = true;
      try {
        await options.prepareInstall();
      } catch (err) {
        installing = false;
        throw new Error(errorText(err), { cause: err });
      }
      // Recorded before the installer can quit the app: if the update never
      // takes effect, the next launch finds this record and reports it.
      if (downloadedVersion) writeInstallRecord(downloadedVersion);
      // quitAndInstall(isSilent, isForceRunAfter): run the installer without its
      // wizard, then relaunch the app once it finishes. Failures that happen
      // later are reported through the 'error' listener, which restarts the server.
      try {
        updater().quitAndInstall(true, true);
      } catch (err) {
        // Threw before the installer started: undo the prepared stop now.
        installing = false;
        removeInstallRecord();
        await options.resumeAfterFailedInstall().catch((restartErr: unknown) => {
          console.error(`[desktop] could not restart after a failed update: ${errorText(restartErr)}`);
        });
        throw new Error(readableUpdateError(err), { cause: err });
      }
    },

    async installError(): Promise<string | null> {
      return takeInstallFailure();
    },
  };
}

function installRecordPath(): string {
  return join(app.getPath('userData'), INSTALL_RECORD_FILE);
}

function writeInstallRecord(target: string): void {
  const record = { target, from: app.getVersion(), at: new Date().toISOString() };
  try {
    writeFileSync(installRecordPath(), JSON.stringify(record), { mode: 0o600 });
  } catch (err) {
    console.error(`[desktop] could not record the update attempt: ${errorText(err)}`);
  }
}

function removeInstallRecord(): void {
  try {
    rmSync(installRecordPath(), { force: true });
  } catch (err) {
    console.error(`[desktop] could not clear the update record: ${errorText(err)}`);
  }
}

/** Reads and clears the install record; returns the failure message if the install did not take effect. */
function takeInstallFailure(): string | null {
  let raw: string;
  try {
    raw = readFileSync(installRecordPath(), 'utf8');
  } catch {
    return null;
  }
  // Cleared whatever the outcome, so a failure is reported at most once.
  removeInstallRecord();
  return installFailureFrom(raw, app.getVersion());
}

/** One readable line, bounded in length. Never includes stack traces. */
function readableUpdateError(err: unknown): string {
  const firstLine = errorText(err).split('\n')[0]?.trim() ?? '';
  const text = firstLine.length > 0 ? firstLine : 'Unknown error.';
  return `Update failed: ${text.slice(0, 240)}`;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
