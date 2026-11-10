import type { SettingsStore } from '@open-record/state';
import { connectDesktop, type OpenRecordDesktopApi } from './desktop-bridge';

const BUNDLED = 'http://127.0.0.1:47900';

function bridge(): OpenRecordDesktopApi {
  return {
    getConnection: vi.fn(async () => ({ url: BUNDLED, token: 'static-token' })),
  } as unknown as OpenRecordDesktopApi;
}

/** Only the members `connectDesktop` reads; `ownServerUrl` is the saved own server. */
function settings(ownServerUrl: string) {
  const setDownloadServer = vi.fn(async () => undefined);
  const store = {
    ready: async () => undefined,
    ownServerUrl: () => ownServerUrl,
    setDownloadServer,
  } as unknown as SettingsStore;
  return { store, setDownloadServer };
}

describe('connectDesktop', () => {
  it('saves the bundled server as the own server, even in public mode', async () => {
    // Public mode: the effective server is the public URL, the own server is unset.
    const { store, setDownloadServer } = settings('');

    await connectDesktop(store, bridge());

    expect(setDownloadServer).toHaveBeenCalledWith({
      url: BUNDLED,
      token: 'static-token',
    });
  });

  it('never overwrites a different own server the user chose', async () => {
    const { store, setDownloadServer } = settings(
      'https://self-hosted.example.com',
    );

    await connectDesktop(store, bridge());

    expect(setDownloadServer).not.toHaveBeenCalled();
  });
});
