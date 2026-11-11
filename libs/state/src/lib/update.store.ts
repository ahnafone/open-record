import {
  DestroyRef,
  Injectable,
  InjectionToken,
  computed,
  inject,
  signal,
  type Signal,
} from '@angular/core';
import { WEB_BUILD } from './ports';
import {
  UPDATE_PLATFORM,
  UPDATE_REPO,
  type UpdateNotice,
  type UpdatePhase,
  type UpdateRelease,
} from './update.types';
import { compareVersions, normalizeVersion, parseVersion, type SemVer } from './update-version';

/**
 * The app's own version (plain semver), used when the platform cannot report
 * one (notify-only platforms such as iOS). Provided by the app from package.json.
 */
export const UPDATE_APP_VERSION = new InjectionToken<string | null>('UPDATE_APP_VERSION', {
  factory: () => null,
});

/** Re-check interval while the app runs. */
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Abort a GitHub request that takes longer than this. */
const FETCH_TIMEOUT_MS = 15_000;

const CHECK_FAILED = "Couldn't check for updates. Try again later.";
const DOWNLOAD_FAILED = "Couldn't download the update. Try again.";
const RESTART_FAILED = "Couldn't restart to install the update.";

const KEY_CHECK = 'or.update.checkForUpdates';
const KEY_AUTO = 'or.update.autoUpdate';
const KEY_SKIPPED = 'or.update.skippedVersion';

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    // Storage can be blocked outright (privacy modes, sandboxed iframes).
    return undefined;
  }
}

/** Reads a `'1'`/`'0'` flag; the fallback when missing or unreadable. */
function readFlag(key: string, fallback: boolean): boolean {
  try {
    const raw = storage()?.getItem(key);
    if (raw === '1') return true;
    if (raw === '0') return false;
  } catch {
    // Best effort: fall through to the default.
  }
  return fallback;
}

function writeFlag(key: string, on: boolean): void {
  try {
    storage()?.setItem(key, on ? '1' : '0');
  } catch {
    // Best effort: the choice is kept for this session only.
  }
}

function readString(key: string): string | null {
  try {
    return storage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeString(key: string, value: string | null): void {
  try {
    if (value === null) storage()?.removeItem(key);
    else storage()?.setItem(key, value);
  } catch {
    // Best effort.
  }
}

function messageOf(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

interface GithubAsset {
  name?: unknown;
  browser_download_url?: unknown;
  digest?: unknown;
}

interface GithubRelease {
  tag_name?: unknown;
  html_url?: unknown;
  body?: unknown;
  draft?: unknown;
  prerelease?: unknown;
  assets?: unknown;
}

/** True for an absolute `https:` URL only (same rule as the release-notes links). */
function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/** One GitHub release as an `UpdateRelease`, with its parsed version; null when unusable. */
function readRelease(raw: GithubRelease): { parsed: SemVer; release: UpdateRelease } | null {
  if (!raw || typeof raw !== 'object' || raw.draft === true) return null;
  if (typeof raw.tag_name !== 'string') return null;
  const parsed = parseVersion(raw.tag_name);
  const version = normalizeVersion(raw.tag_name);
  if (!parsed || !version) return null;

  const assets: GithubAsset[] = Array.isArray(raw.assets) ? (raw.assets as GithubAsset[]) : [];
  const apk = assets.find(
    (a) =>
      typeof a?.name === 'string' &&
      a.name.toLowerCase().endsWith('.apk') &&
      typeof a.browser_download_url === 'string',
  );
  const digest =
    apk && typeof apk.digest === 'string' ? /^sha256:([0-9a-f]{64})$/i.exec(apk.digest) : null;
  const checksum = apk ? findChecksumAsset(assets, apk.name as string) : null;

  const fallbackUrl = `https://github.com/${UPDATE_REPO}/releases`;
  return {
    parsed,
    release: {
      version,
      url: typeof raw.html_url === 'string' && isHttpsUrl(raw.html_url) ? raw.html_url : fallbackUrl,
      notes: typeof raw.body === 'string' ? raw.body : '',
      apkUrl: apk ? (apk.browser_download_url as string) : null,
      apkSha256: digest ? digest[1].toLowerCase() : null,
      apkChecksumUrl: checksum,
      prerelease: raw.prerelease === true,
    },
  };
}

/** Download URL of the checksum asset for the APK: `SHA256SUMS` first, else `<apk>.sha256`. */
function findChecksumAsset(assets: GithubAsset[], apkName: string): string | null {
  const usable = assets.filter(
    (a) => typeof a?.name === 'string' && typeof a.browser_download_url === 'string',
  );
  const wanted = ['SHA256SUMS', `${apkName}.sha256`];
  for (const name of wanted) {
    const hit = usable.find((a) => a.name === name);
    if (hit) return hit.browser_download_url as string;
  }
  return null;
}

/** Highest valid release among the GitHub list (drafts and invalid tags ignored); null when none. */
function pickLatest(list: unknown[]): UpdateRelease | null {
  let best: { parsed: SemVer; release: UpdateRelease } | null = null;
  for (const raw of list) {
    const candidate = readRelease(raw as GithubRelease);
    if (candidate && (!best || compareVersions(candidate.parsed, best.parsed) > 0)) {
      best = candidate;
    }
  }
  return best?.release ?? null;
}

/** True when `candidate` is a newer valid version than `installed`. */
function isNewer(candidate: string, installed: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(installed);
  return a !== null && b !== null && compareVersions(a, b) > 0;
}

/** Fetches the newest release of `UPDATE_REPO` (prereleases included). Throws on any failure. */
async function fetchLatestRelease(): Promise<UpdateRelease | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await globalThis.fetch(
      `https://api.github.com/repos/${UPDATE_REPO}/releases?per_page=10`,
      { headers: { accept: 'application/vnd.github+json' }, signal: controller.signal },
    );
    if (!res.ok) throw new Error(`GitHub responded ${res.status}`);
    const body: unknown = await res.json();
    if (!Array.isArray(body)) throw new Error('Unexpected releases response');
    return pickLatest(body);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * App updates: preferences, the periodic check, the release the app offers,
 * and the download / restart actions. Platform work goes through
 * `UPDATE_PLATFORM` (null on web and iOS, which are notify-only or nothing).
 * Never throws to the UI: failures land in `error` or are silent for
 * automatic checks.
 */
@Injectable({ providedIn: 'root' })
export class UpdateStore {
  private readonly platform = inject(UPDATE_PLATFORM);
  private readonly appVersion = inject(UPDATE_APP_VERSION);
  private readonly webBuild = inject(WEB_BUILD);

  private readonly _checkForUpdates = signal(readFlag(KEY_CHECK, true));
  private readonly _autoUpdate = signal(readFlag(KEY_AUTO, true));
  private readonly _skippedVersion = signal(readString(KEY_SKIPPED));
  private readonly _phase = signal<UpdatePhase>('idle');
  private readonly _release = signal<UpdateRelease | null>(null);
  private readonly _progress = signal<number | null>(null);
  private readonly _error = signal<string | null>(null);
  private readonly _currentVersion = signal<string | null>(null);
  /** Refreshed after the platform reports its version: some platforms learn it asynchronously. */
  private readonly _canSelfUpdate = signal(false);
  private readonly _lastCheckedAt = signal<number | null>(null);
  private readonly _upToDate = signal(false);
  private readonly _checking = signal(false);

  /** Background checks on (on start, then every 6 hours). */
  readonly checkForUpdates: Signal<boolean> = this._checkForUpdates.asReadonly();
  /** Download new versions in the background (self-update platforms only). */
  readonly autoUpdate: Signal<boolean> = this._autoUpdate.asReadonly();
  /** Version the user chose to skip, or null. */
  readonly skippedVersion: Signal<string | null> = this._skippedVersion.asReadonly();
  readonly phase: Signal<UpdatePhase> = this._phase.asReadonly();
  /** The newest release found (even when skipped), or null. */
  readonly release: Signal<UpdateRelease | null> = this._release.asReadonly();
  /** Download progress 0..1, or null when not downloading. */
  readonly progress: Signal<number | null> = this._progress.asReadonly();
  /** Readable error for the last failed check (manual), download or restart; null when none. */
  readonly error: Signal<string | null> = this._error.asReadonly();
  /** Installed version (plain semver); null until the first check resolves it. */
  readonly currentVersion: Signal<string | null> = this._currentVersion.asReadonly();
  /** Epoch ms of the last successful check; null when none. */
  readonly lastCheckedAt: Signal<number | null> = this._lastCheckedAt.asReadonly();
  /** True after a successful check found nothing newer. */
  readonly upToDate: Signal<boolean> = this._upToDate.asReadonly();
  /** A check request is in flight. */
  readonly checking: Signal<boolean> = this._checking.asReadonly();
  /** The platform can download and restart to install (Electron). */
  readonly canSelfUpdate: Signal<boolean> = this._canSelfUpdate.asReadonly();
  /** The platform can download the APK and hand it to the system installer (Android). */
  readonly canInstallApk: Signal<boolean> = computed(() => this.platform?.canInstallApk === true);
  /**
   * What the sidebar About item shows. `available` only while checks are on
   * and the release is not skipped; `ready` whenever an update is downloaded.
   */
  readonly notice: Signal<UpdateNotice> = computed<UpdateNotice>(() => {
    const phase = this._phase();
    if (phase === 'ready') return 'ready';
    const release = this._release();
    // An 'error' phase keeps the release when a download, permission or manual
    // check failed, so the offer (and its badge) stays visible.
    if (
      (phase === 'available' || phase === 'downloading' || (phase === 'error' && release !== null)) &&
      this._checkForUpdates() &&
      release !== null &&
      release.version !== this._skippedVersion()
    ) {
      return 'available';
    }
    return 'none';
  });

  private started = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly unsubscribe: Array<() => void> = [];

  constructor() {
    if (this.platform) {
      const platform = this.platform;
      this.unsubscribe.push(
        platform.onProgress((fraction) => {
          if (this._phase() === 'downloading') {
            this._progress.set(Math.min(1, Math.max(0, fraction)));
          }
        }),
        platform.onDownloaded(() => {
          this._phase.set('ready');
          this._progress.set(1);
          this._error.set(null);
        }),
      );
    }
    inject(DestroyRef).onDestroy(() => {
      this.stopTimer();
      for (const off of this.unsubscribe) off();
    });
  }

  /**
   * Call once at app launch. Checks now and every 6 hours while checks are on.
   * Does nothing on web (no platform and the web build).
   */
  start(): void {
    if (this.started) return;
    if (!this.platform && this.webBuild) return;
    this.started = true;
    // Learn platform capabilities even when automatic checks are off.
    void this.readCurrentVersion().then((v) => {
      if (this._currentVersion() === null) this._currentVersion.set(v);
    });
    void this.launch();
    this.syncTimer();
  }

  /** Reports a failed install from the previous run, then checks. The check runs after, so it never clears the notice. */
  private async launch(): Promise<void> {
    const failure = await this.readInstallError();
    if (failure) {
      this._phase.set('error');
      this._error.set(`The last update could not be installed: ${failure}`);
    }
    await this.check();
  }

  /** The platform's message for a failed restart-and-install on the last run; null when none. */
  private async readInstallError(): Promise<string | null> {
    const platform = this.platform;
    if (!platform?.installError) return null;
    try {
      const message = await platform.installError();
      return message && message.trim() ? message.trim() : null;
    } catch {
      return null;
    }
  }

  /**
   * Looks for a newer release. Automatic checks (`manual` false) do nothing
   * while checks are off, and never report errors. A manual check ignores the
   * skipped version for display but does not clear the skip.
   */
  async check({ manual = false }: { manual?: boolean } = {}): Promise<void> {
    if (!manual && !this._checkForUpdates()) return;
    if (this._checking()) return;
    // Never disturb a download in progress or a downloaded update.
    const before = this._phase();
    if (before === 'downloading' || before === 'ready') return;

    // An error stands until the user runs a manual check or download. Automatic
    // checks update the release but leave the phase and the error alone.
    const holdsError = before === 'error' && !manual;

    this._checking.set(true);
    if (before === 'idle' || (before === 'error' && manual)) this._phase.set('checking');
    try {
      const current = await this.readCurrentVersion();
      const latest = await fetchLatestRelease();
      this._currentVersion.set(current);
      this._lastCheckedAt.set(Date.now());

      // A download started while this request was in flight. It owns the phase
      // and the release it is fetching, so the result is dropped.
      if (this.downloadActive()) return;

      // Only write the phase and error if nothing else moved them meanwhile.
      const phaseNow = this._phase();
      const phaseOwned = phaseNow === 'checking' || (phaseNow === before && !holdsError);
      if (phaseOwned) this._error.set(null);

      if (current !== null && latest !== null && isNewer(latest.version, current)) {
        this._release.set(latest);
        this._upToDate.set(false);
        if (phaseOwned) this._phase.set('available');
        if (
          phaseOwned &&
          !this.isSkipped(latest.version) &&
          this._autoUpdate() &&
          this._checkForUpdates() &&
          this.platform?.canSelfUpdate === true
        ) {
          void this.download();
        }
      } else {
        this._release.set(null);
        this._upToDate.set(current !== null);
        if (phaseOwned) this._phase.set('idle');
      }
    } catch {
      // Back to the phase we started from, so a failed check never hides an
      // update that was already offered. Only a manual check reports, and only
      // when no download has taken over. An existing error (a download or install
      // failure, possibly set while this check was in flight) is never overwritten.
      if (this._phase() === 'checking') this._phase.set(before);
      if (
        manual &&
        this._error() === null &&
        this._phase() !== 'error' &&
        !this.downloadActive()
      ) {
        this._error.set(CHECK_FAILED);
      }
    } finally {
      this._checking.set(false);
    }
  }

  /**
   * Starts the update for the current release. Electron: background download,
   * `ready` once downloaded. Android: downloads the APK and opens the system
   * installer, then returns to `available` (the user may cancel). No-op when
   * the platform cannot update or there is no release.
   */
  async download(): Promise<void> {
    const release = this._release();
    const platform = this.platform;
    if (!release || !platform) return;
    // A check in flight may be about to change the release; wait for it to finish.
    const phase = this._phase();
    if (phase === 'checking' || phase === 'downloading' || phase === 'ready') return;

    if (platform.canSelfUpdate) {
      this._phase.set('downloading');
      this._progress.set(0);
      this._error.set(null);
      try {
        // Resolves once the main process has finished the download. The
        // `onDownloaded` event normally arrives first; this covers a missed event.
        await platform.download(release);
        if (this._phase() === 'downloading') {
          this._phase.set('ready');
          this._progress.set(1);
        }
      } catch (err) {
        this._progress.set(null);
        this._error.set(messageOf(err, DOWNLOAD_FAILED));
        this._phase.set('error');
      }
      return;
    }

    if (platform.canInstallApk) {
      if (!release.apkUrl) {
        this._error.set('This release has no Android APK.');
        this._phase.set('error');
        return;
      }
      this._phase.set('downloading');
      this._progress.set(0);
      this._error.set(null);
      try {
        await platform.download(release);
        // The installer is open; the user may still cancel it, so the release stays offered.
        if (this._phase() === 'downloading') this._phase.set('available');
      } catch (err) {
        this._error.set(messageOf(err, DOWNLOAD_FAILED));
        this._phase.set('error');
      } finally {
        this._progress.set(null);
      }
    }
  }

  /** Quits and installs a downloaded update (Electron). No-op unless `ready`. */
  async restartAndInstall(): Promise<void> {
    const platform = this.platform;
    if (this._phase() !== 'ready' || !platform) return;
    try {
      await platform.restartAndInstall();
    } catch (err) {
      this._error.set(messageOf(err, RESTART_FAILED));
    }
  }

  setCheckForUpdates(on: boolean): void {
    this._checkForUpdates.set(on);
    writeFlag(KEY_CHECK, on);
    this.syncTimer();
    if (on && this.started) void this.check();
  }

  setAutoUpdate(on: boolean): void {
    this._autoUpdate.set(on);
    writeFlag(KEY_AUTO, on);
    const release = this._release();
    if (
      on &&
      release &&
      this._phase() === 'available' &&
      this._checkForUpdates() &&
      this.platform?.canSelfUpdate === true &&
      !this.isSkipped(release.version)
    ) {
      void this.download();
    }
  }

  /** Hides the offered release from the sidebar until a newer one appears. */
  skipVersion(): void {
    const release = this._release();
    if (!release) return;
    this._skippedVersion.set(release.version);
    writeString(KEY_SKIPPED, release.version);
  }

  clearSkip(): void {
    this._skippedVersion.set(null);
    writeString(KEY_SKIPPED, null);
  }

  private isSkipped(version: string): boolean {
    return this._skippedVersion() === version;
  }

  /** A download is running or finished; a check must not change what is being downloaded. */
  private downloadActive(): boolean {
    const phase = this._phase();
    return phase === 'downloading' || phase === 'ready';
  }

  /** Installed version from the platform, else the app's own version. Null when neither parses. */
  private async readCurrentVersion(): Promise<string | null> {
    let reported: string | null = null;
    if (this.platform) {
      try {
        reported = await this.platform.currentVersion();
      } catch {
        reported = null;
      }
      this._canSelfUpdate.set(this.platform.canSelfUpdate === true);
    }
    return (
      normalizeVersion(reported ?? '') ?? normalizeVersion(this.appVersion ?? '') ?? null
    );
  }

  private syncTimer(): void {
    const wanted = this.started && this._checkForUpdates();
    if (wanted && this.timer === undefined) {
      this.timer = setInterval(() => void this.check(), UPDATE_CHECK_INTERVAL_MS);
    } else if (!wanted) {
      this.stopTimer();
    }
  }

  private stopTimer(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
