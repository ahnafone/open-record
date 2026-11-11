import type { UpdatePlatform, UpdateRelease } from '@open-record/state';
import { createAndroidUpdatePlatform } from './update-platform-android';

const plugin = {
  getVersion: vi.fn(async () => ({ version: 'v0.0.4' })),
  download: vi.fn(async () => ({ path: '/cache/updates/open-record-update.apk' })),
  canInstall: vi.fn(async () => ({ granted: true })),
  openInstallSettings: vi.fn(async () => undefined),
  install: vi.fn(async () => undefined),
  addListener: vi.fn(async () => ({ remove: async () => undefined })),
};

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: () => 'android',
    isPluginAvailable: () => true,
  },
  registerPlugin: () => plugin,
}));

const release: UpdateRelease = {
  version: '0.0.5',
  url: 'https://github.com/ahnafone/open-record/releases/tag/v0.0.5',
  notes: '',
  apkUrl: 'https://github.com/ahnafone/open-record/releases/download/v0.0.5/app-release.apk',
  apkSha256: null,
  apkChecksumUrl: 'https://github.com/ahnafone/open-record/releases/download/v0.0.5/SHA256SUMS',
  prerelease: false,
};

/** The adapter is only created on Android, which the mock reports. */
function createdPlatform(): UpdatePlatform {
  const platform = createAndroidUpdatePlatform();
  if (!platform) throw new Error('expected an Android update platform');
  return platform;
}

describe('createAndroidUpdatePlatform', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects when the release has no APK and never touches the plugin', async () => {
    const platform = createdPlatform();

    await expect(platform.download({ ...release, apkUrl: null })).rejects.toThrow(
      'No APK attached to this release',
    );
    expect(plugin.download).not.toHaveBeenCalled();
    expect(plugin.install).not.toHaveBeenCalled();
  });

  it('rejects without downloading when no checksum is published', async () => {
    const platform = createdPlatform();

    await expect(
      platform.download({ ...release, apkSha256: null, apkChecksumUrl: null }),
    ).rejects.toThrow('No checksum published for this release; cannot verify the update.');
    expect(plugin.canInstall).not.toHaveBeenCalled();
    expect(plugin.download).not.toHaveBeenCalled();
    expect(plugin.install).not.toHaveBeenCalled();
  });

  it('passes the checksum sources to the native download', async () => {
    const platform = createdPlatform();

    await platform.download(release);

    expect(plugin.download).toHaveBeenCalledWith({
      url: release.apkUrl,
      checksumUrl: release.apkChecksumUrl,
    });
    expect(plugin.install).toHaveBeenCalledTimes(1);
  });

  it('opens install settings and rejects without downloading when the permission is missing', async () => {
    plugin.canInstall.mockResolvedValueOnce({ granted: false });
    const platform = createdPlatform();

    await expect(platform.download(release)).rejects.toThrow(
      'Allow Open Record to install apps, then tap Download and install again.',
    );
    expect(plugin.openInstallSettings).toHaveBeenCalledTimes(1);
    expect(plugin.download).not.toHaveBeenCalled();
    expect(plugin.install).not.toHaveBeenCalled();
  });
});
