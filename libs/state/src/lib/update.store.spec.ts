import { TestBed } from '@angular/core/testing';
import { UPDATE_APP_VERSION, UpdateStore } from './update.store';
import { UPDATE_PLATFORM, type UpdatePlatform } from './update.types';

const SHA = 'a'.repeat(64);
const APK_URL = 'https://example.test/app-0.0.6-beta.1.apk';

/** A GitHub release as the releases API returns it (only the fields the store reads). */
function ghRelease(tag: string, extra: Record<string, unknown> = {}) {
  return {
    tag_name: tag,
    html_url: `https://github.com/ahnafone/open-record/releases/tag/${tag}`,
    body: `notes for ${tag}`,
    draft: false,
    prerelease: tag.includes('-'),
    assets: [],
    ...extra,
  };
}

/**
 * Electron-style fake. By default `download` never resolves (the download is
 * still running); with `downloadResolves` it resolves at once, like the main
 * process does after the download has completed. `emitDownloaded` simulates the
 * `update-downloaded` event.
 */
function fakeElectron({
  downloadResolves = false,
  installFailure = null,
}: { downloadResolves?: boolean; installFailure?: string | null } = {}) {
  const downloadedListeners: Array<() => void> = [];
  const platform = {
    kind: 'electron' as const,
    currentVersion: vi.fn(async () => '0.0.4'),
    canSelfUpdate: true,
    canInstallApk: false,
    download: vi.fn(() =>
      downloadResolves ? Promise.resolve() : new Promise<void>(() => undefined),
    ),
    onProgress: () => () => undefined,
    onDownloaded: (listener: () => void) => {
      downloadedListeners.push(listener);
      return () => undefined;
    },
    restartAndInstall: vi.fn(async () => undefined),
    installError: vi.fn(async () => installFailure),
  };
  return {
    platform,
    emitDownloaded: () => downloadedListeners.forEach((listener) => listener()),
  };
}

/** Boots the store with the given platform and preferences (flags are stored as `'1'`/`'0'`). */
function boot(
  platform: UpdatePlatform | null,
  prefs: { checkForUpdates?: boolean; autoUpdate?: boolean; skippedVersion?: string } = {},
): UpdateStore {
  TestBed.resetTestingModule();
  localStorage.clear();
  if (prefs.checkForUpdates !== undefined) {
    localStorage.setItem('or.update.checkForUpdates', prefs.checkForUpdates ? '1' : '0');
  }
  if (prefs.autoUpdate !== undefined) {
    localStorage.setItem('or.update.autoUpdate', prefs.autoUpdate ? '1' : '0');
  }
  if (prefs.skippedVersion !== undefined) {
    localStorage.setItem('or.update.skippedVersion', prefs.skippedVersion);
  }
  TestBed.configureTestingModule({
    providers: [
      { provide: UPDATE_PLATFORM, useValue: platform },
      { provide: UPDATE_APP_VERSION, useValue: '0.0.4' },
    ],
  });
  return TestBed.inject(UpdateStore);
}

/** Replaces the global `fetch` with a releases-list response. */
function mockGithub(releases: unknown[]) {
  const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => releases }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** Makes every GitHub request fail (offline). */
function mockGithubOffline() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('offline');
    }),
  );
}

/** Android-style fake: no self-update, APK download through the plugin; `download` rejects with `failure`. */
function fakeAndroid(failure: string) {
  return {
    kind: 'android' as const,
    currentVersion: vi.fn(async () => '0.0.4'),
    canSelfUpdate: false,
    canInstallApk: true,
    download: vi.fn(async () => {
      throw new Error(failure);
    }),
    onProgress: () => () => undefined,
    onDownloaded: () => () => undefined,
    restartAndInstall: vi.fn(async () => undefined),
  };
}

describe('UpdateStore', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows no notice and skips automatic checks when checks are off; a manual check still reports', async () => {
    const { platform } = fakeElectron();
    const store = boot(platform, { checkForUpdates: false });
    const fetchMock = mockGithub([ghRelease('v0.0.5')]);

    await store.check();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.notice()).toBe('none');

    await store.check({ manual: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(store.phase()).toBe('available');
    expect(store.release()?.version).toBe('0.0.5');
    expect(store.notice()).toBe('none');
  });

  it('hides the notice for a skipped version; a manual check still shows it without clearing the skip', async () => {
    const store = boot(null);
    mockGithub([ghRelease('v0.0.5')]);

    await store.check();
    expect(store.notice()).toBe('available');

    store.skipVersion();
    expect(store.notice()).toBe('none');
    expect(localStorage.getItem('or.update.skippedVersion')).toBe('0.0.5');

    await store.check({ manual: true });
    expect(store.release()?.version).toBe('0.0.5');
    expect(store.notice()).toBe('none');
    expect(store.skippedVersion()).toBe('0.0.5');
  });

  it('never auto-downloads a skipped version', async () => {
    const { platform } = fakeElectron();
    const store = boot(platform, { skippedVersion: '0.0.5' });
    mockGithub([ghRelease('v0.0.5')]);

    await store.check();

    expect(store.release()?.version).toBe('0.0.5');
    expect(platform.download).not.toHaveBeenCalled();
    expect(store.notice()).toBe('none');
  });

  it('picks the highest valid release (pre-releases included) and its own APK', async () => {
    const store = boot(null);
    mockGithub([
      ghRelease('v0.0.5', {
        assets: [{ name: 'app-0.0.5.apk', browser_download_url: 'https://example.test/old.apk' }],
      }),
      ghRelease('v0.0.6-beta.1', {
        body: 'beta notes',
        assets: [
          { name: 'app-setup.exe', browser_download_url: 'https://example.test/app.exe' },
          {
            name: 'app-0.0.6-beta.1.apk',
            browser_download_url: APK_URL,
            digest: `sha256:${SHA}`,
          },
        ],
      }),
      ghRelease('v0.0.9', { draft: true }),
      ghRelease('nightly'),
    ]);

    await store.check();

    const release = store.release();
    expect(release?.version).toBe('0.0.6-beta.1');
    expect(release?.prerelease).toBe(true);
    expect(release?.notes).toBe('beta notes');
    expect(release?.apkUrl).toBe(APK_URL);
    expect(release?.apkSha256).toBe(SHA);
    expect(store.phase()).toBe('available');
    expect(store.notice()).toBe('available');
  });

  it('auto-downloads a new release and shows ready once the platform reports it downloaded', async () => {
    const { platform, emitDownloaded } = fakeElectron();
    const store = boot(platform);
    mockGithub([ghRelease('v0.0.5')]);

    await store.check();

    expect(platform.download).toHaveBeenCalledWith(
      expect.objectContaining({ version: '0.0.5' }),
    );
    expect(store.phase()).toBe('downloading');
    expect(store.notice()).toBe('available');

    emitDownloaded();
    expect(store.phase()).toBe('ready');
    expect(store.notice()).toBe('ready');
  });

  it('becomes ready when the platform download resolves, even without the downloaded event', async () => {
    const { platform } = fakeElectron({ downloadResolves: true });
    const store = boot(platform);
    mockGithub([ghRelease('v0.0.5')]);

    await store.check();

    await vi.waitFor(() => expect(store.phase()).toBe('ready'));
    expect(store.progress()).toBe(1);
    expect(store.notice()).toBe('ready');
  });

  it('keeps an offered release and its phase when a manual check fails', async () => {
    const store = boot(null);
    mockGithub([ghRelease('v0.0.5')]);
    await store.check();
    expect(store.phase()).toBe('available');

    mockGithubOffline();
    await store.check({ manual: true });

    expect(store.phase()).toBe('available');
    expect(store.release()?.version).toBe('0.0.5');
    expect(store.error()).toBe("Couldn't check for updates. Try again later.");
    expect(store.notice()).toBe('available');
  });

  it('reports a failed manual check from idle without offering anything', async () => {
    const store = boot(null);
    mockGithubOffline();

    await store.check({ manual: true });

    expect(store.phase()).toBe('idle');
    expect(store.release()).toBeNull();
    expect(store.error()).not.toBeNull();
    expect(store.notice()).toBe('none');
  });

  it('stays silent when an automatic check fails', async () => {
    const store = boot(null);
    mockGithubOffline();

    await store.check();

    expect(store.phase()).toBe('idle');
    expect(store.error()).toBeNull();
  });

  it('keeps the offer visible after an Android download failure', async () => {
    const platform = fakeAndroid('Allow Open Record to install apps');
    const store = boot(platform);
    mockGithub([
      ghRelease('v0.0.5', {
        assets: [{ name: 'app-0.0.5.apk', browser_download_url: APK_URL }],
      }),
    ]);
    await store.check();

    await store.download();

    expect(platform.download).toHaveBeenCalledTimes(1);
    expect(store.phase()).toBe('error');
    expect(store.error()).toBe('Allow Open Record to install apps');
    expect(store.release()?.version).toBe('0.0.5');
    expect(store.notice()).toBe('available');
  });

  it('hides a failed-state offer when checks are off or the version is skipped', async () => {
    const platform = fakeAndroid('network down');
    const store = boot(platform, { skippedVersion: '0.0.5' });
    mockGithub([
      ghRelease('v0.0.5', {
        assets: [{ name: 'app-0.0.5.apk', browser_download_url: APK_URL }],
      }),
    ]);
    await store.check({ manual: true });
    await store.download();

    expect(store.phase()).toBe('error');
    expect(store.notice()).toBe('none');

    store.clearSkip();
    expect(store.notice()).toBe('available');

    store.setCheckForUpdates(false);
    expect(store.notice()).toBe('none');
  });

  it('keeps a download error when a later manual check fails', async () => {
    const platform = fakeAndroid('network down');
    const store = boot(platform);
    mockGithub([
      ghRelease('v0.0.5', { assets: [{ name: 'app-0.0.5.apk', browser_download_url: APK_URL }] }),
    ]);
    await store.check();
    await store.download();
    expect(store.error()).toBe('network down');

    mockGithubOffline();
    await store.check({ manual: true });

    expect(store.phase()).toBe('error');
    expect(store.error()).toBe('network down');
    expect(store.release()?.version).toBe('0.0.5');
  });

  it('a failed manual check does not overwrite a download error that landed while it was in flight', async () => {
    const platform = fakeAndroid('network down');
    const store = boot(platform);
    mockGithub([
      ghRelease('v0.0.5', { assets: [{ name: 'app-0.0.5.apk', browser_download_url: APK_URL }] }),
    ]);
    await store.check();
    expect(store.phase()).toBe('available');

    // Hold the manual check's GitHub request open, then fail it after the download error.
    let offline!: (err: Error) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise((_resolve, reject) => (offline = reject))),
    );
    const checking = store.check({ manual: true });
    await vi.waitFor(() => expect(offline).toBeDefined());

    await store.download();
    expect(store.phase()).toBe('error');
    expect(store.error()).toBe('network down');

    offline(new Error('offline'));
    await checking;

    expect(store.phase()).toBe('error');
    expect(store.error()).toBe('network down');
  });

  it('keeps a failed install from the last run through automatic checks until a manual check', async () => {
    const { platform } = fakeElectron({ installFailure: 'Access denied' });
    const store = boot(platform, { autoUpdate: true });
    const fetchMock = mockGithub([ghRelease('v0.0.5')]);

    store.start();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await vi.waitFor(() => expect(store.checking()).toBe(false));

    expect(store.phase()).toBe('error');
    expect(store.error()).toBe('The last update could not be installed: Access denied');
    expect(store.release()?.version).toBe('0.0.5');
    expect(store.notice()).toBe('available');
    // The automatic check must not start a new download over the failure.
    expect(platform.download).not.toHaveBeenCalled();

    mockGithub([ghRelease('v0.0.5')]);
    await store.check({ manual: true });
    expect(store.error()).toBeNull();
    expect(store.phase()).not.toBe('error');
  });

  it('chooses the APK checksum asset: SHA256SUMS first, else <apk>.sha256', async () => {
    const apk = { name: 'app-0.0.6.apk', browser_download_url: APK_URL };
    const sums = { name: 'SHA256SUMS', browser_download_url: 'https://example.test/SHA256SUMS' };
    const perApk = {
      name: 'app-0.0.6.apk.sha256',
      browser_download_url: 'https://example.test/app-0.0.6.apk.sha256',
    };

    const both = boot(null);
    mockGithub([ghRelease('v0.0.6', { assets: [apk, perApk, sums] })]);
    await both.check();
    expect(both.release()?.apkChecksumUrl).toBe('https://example.test/SHA256SUMS');

    const onlyPerApk = boot(null);
    mockGithub([ghRelease('v0.0.6', { assets: [apk, perApk] })]);
    await onlyPerApk.check();
    expect(onlyPerApk.release()?.apkChecksumUrl).toBe(
      'https://example.test/app-0.0.6.apk.sha256',
    );

    const none = boot(null);
    mockGithub([ghRelease('v0.0.6', { assets: [apk] })]);
    await none.check();
    expect(none.release()?.apkChecksumUrl).toBeNull();
  });

  it('download tapped during in-flight check keeps downloading phase', async () => {
    const { platform } = fakeElectron();
    const store = boot(platform, { autoUpdate: false });
    mockGithub([ghRelease('v0.0.5')]);
    await store.check();
    expect(store.phase()).toBe('available');

    // Hold the next GitHub response so the manual check stays in flight.
    let respond!: (res: unknown) => void;
    const fetchMock = vi.fn(() => new Promise((resolve) => (respond = resolve)));
    vi.stubGlobal('fetch', fetchMock);
    const checking = store.check({ manual: true });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

    // Not awaited: the platform download never resolves in this fake.
    void store.download();
    expect(store.phase()).toBe('downloading');

    respond({ ok: true, status: 200, json: async () => [ghRelease('v0.0.6')] });
    await checking;

    expect(store.phase()).toBe('downloading');
    expect(store.release()?.version).toBe('0.0.5');
    expect(store.notice()).toBe('available');
  });
});
