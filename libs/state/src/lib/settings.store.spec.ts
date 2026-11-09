import { TestBed } from '@angular/core/testing';
import { buildPairingLink } from '@open-record/models';
import {
  SETTINGS_KEYS,
  StoragePort,
  createInMemoryStorage,
  type JsonValue,
  type SettingsRepository,
} from '@open-record/storage';
import { defaultDeviceName, ensureDeviceId } from './device-identity';
import { PUBLIC_SERVER, RemoteServerPort } from './ports';
import { SettingsStore } from './settings.store';

function boot(
  storage: StoragePort,
  remote?: RemoteServerPort,
): SettingsStore {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: StoragePort, useValue: storage },
      ...(remote ? [{ provide: RemoteServerPort, useValue: remote }] : []),
    ],
  });
  return TestBed.inject(SettingsStore);
}

/** A storage whose settings writes fail for the given keys. */
function storageWithFailingWrites(
  storage: StoragePort,
  keys: ReadonlySet<string>,
): StoragePort {
  const settings: SettingsRepository = {
    get: <T extends JsonValue>(key: string) => storage.settings.get<T>(key),
    set: (key, value) =>
      keys.has(key)
        ? Promise.reject(new Error('write failed'))
        : storage.settings.set(key, value),
    delete: (key) => storage.settings.delete(key),
  };
  return { settings } as unknown as StoragePort;
}

describe('SettingsStore device identity', () => {
  it('hydrates one stable device id shared by two instances', async () => {
    const storage = createInMemoryStorage();
    const first = boot(storage);
    await first.ready();
    expect(first.deviceId()).toBeTruthy();
    expect(first.deviceName()).toBe(defaultDeviceName());
    expect(first.sessionEnabled()).toBe(true);
    expect(first.castEnabled()).toBe(true);

    const second = boot(storage);
    await second.ready();
    expect(second.deviceId()).toBe(first.deviceId());
    expect(await ensureDeviceId(storage)).toBe(first.deviceId());
  });

  it('persists the device name and session prefs across a reload', async () => {
    const storage = createInMemoryStorage();
    const store = boot(storage);
    await store.ready();
    await store.setDeviceName('  Living room speaker  ');
    await store.setSessionEnabled(false);
    await store.setCastEnabled(false);

    expect(store.deviceName()).toBe('Living room speaker');
    expect(store.sessionEnabled()).toBe(false);
    expect(store.castEnabled()).toBe(false);

    const second = boot(storage);
    await second.ready();
    expect(second.deviceName()).toBe('Living room speaker');
    expect(second.sessionEnabled()).toBe(false);
    expect(second.castEnabled()).toBe(false);
  });

  it('falls back to the platform name for blank or overlong input', async () => {
    const store = boot(createInMemoryStorage());
    await store.ready();
    await store.setDeviceName('Kitchen');
    await store.setDeviceName('   ');
    expect(store.deviceName()).toBe(defaultDeviceName());

    await store.setDeviceName('x'.repeat(100));
    expect(store.deviceName()).toHaveLength(60);
  });

  it('rolls back the name and prefs when a write fails', async () => {
    const backing = createInMemoryStorage();
    const store = boot(
      storageWithFailingWrites(
        backing,
        new Set([SETTINGS_KEYS.deviceName, SETTINGS_KEYS.sessionPrefs]),
      ),
    );
    await store.ready();

    const name = store.deviceName();
    await expect(store.setDeviceName('Kitchen')).rejects.toThrow(
      'write failed',
    );
    expect(store.deviceName()).toBe(name);

    await expect(store.setSessionEnabled(false)).rejects.toThrow(
      'write failed',
    );
    expect(store.sessionEnabled()).toBe(true);

    await expect(store.setCastEnabled(false)).rejects.toThrow('write failed');
    expect(store.castEnabled()).toBe(true);
  });
});

/** A RemoteServerPort whose reachability probe can be made to fail. */
function fakeRemote(probe: () => Promise<void> = async () => undefined): {
  port: RemoteServerPort;
  probeServer: ReturnType<typeof vi.fn>;
  testConnection: ReturnType<typeof vi.fn>;
} {
  let configured = false;
  const probeServer = vi.fn(probe);
  const testConnection = vi.fn(async () => undefined);
  const port = {
    get configured() {
      return configured;
    },
    configure(config: { baseUrl: string; token: string } | null) {
      configured = !!config?.baseUrl;
    },
    probeServer,
    testConnection,
  } as unknown as RemoteServerPort;
  return { port, probeServer, testConnection };
}

const PUBLIC_URL = 'https://public.example.com';

function bootWithPublic(
  storage: StoragePort,
  remote: RemoteServerPort,
): SettingsStore {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: StoragePort, useValue: storage },
      { provide: RemoteServerPort, useValue: remote },
      { provide: PUBLIC_SERVER, useValue: PUBLIC_URL },
    ],
  });
  return TestBed.inject(SettingsStore);
}

describe('SettingsStore connection mode', () => {
  it('switching to the public server and back restores the own server', async () => {
    const storage = createInMemoryStorage();
    const { port } = fakeRemote();
    const store = bootWithPublic(storage, port);
    await store.ready();
    await store.setDownloadServer({ url: 'http://own.example:47900' });

    await store.setConnectionMode('public');
    expect(store.downloadServerUrl()).toBe(PUBLIC_URL);
    expect(store.ownServerUrl()).toBe('http://own.example:47900');

    // Own-server edits are saved but do not replace the public server.
    await store.setDownloadServer({ url: 'http://other.example:47900' });
    expect(store.downloadServerUrl()).toBe(PUBLIC_URL);

    await store.setConnectionMode('own');
    expect(store.downloadServerUrl()).toBe('http://other.example:47900');

    // The mode survives a reload.
    await store.setConnectionMode('public');
    const reloaded = bootWithPublic(storage, port);
    await reloaded.ready();
    expect(reloaded.connectionMode()).toBe('public');
    expect(reloaded.downloadServerUrl()).toBe(PUBLIC_URL);
  });

  it('keeps the own server when the mode write fails', async () => {
    const backing = createInMemoryStorage();
    const { port } = fakeRemote();
    const store = bootWithPublic(
      storageWithFailingWrites(backing, new Set(['connectionMode'])),
      port,
    );
    await store.ready();
    await store.setDownloadServer({ url: 'http://own.example:47900' });

    await expect(store.setConnectionMode('public')).rejects.toThrow('write failed');
    expect(store.connectionMode()).toBe('own');
    expect(store.downloadServerUrl()).toBe('http://own.example:47900');
  });
});

const PHONE_LINK = buildPairingLink({ url: 'http://192.168.1.20:47900' });

describe('SettingsStore pairing', () => {
  it('saves a signed-out phone pairing after the unauthenticated probe', async () => {
    const storage = createInMemoryStorage();
    const { port, probeServer, testConnection } = fakeRemote();
    const store = boot(storage, port);
    await store.ready();

    const result = await store.pairFromLink(PHONE_LINK);

    expect(result).toEqual({
      ok: true,
      message: 'Saved — sign in to continue',
    });
    // Signed out: no authenticated request, but the server was probed.
    expect(probeServer).toHaveBeenCalledTimes(1);
    expect(testConnection).not.toHaveBeenCalled();
    expect(store.downloadServerUrl()).toBe('http://192.168.1.20:47900');
    expect(store.connection().status).toBe('ok');
    expect(
      await storage.settings.get(SETTINGS_KEYS.downloadServer),
    ).toEqual({ url: 'http://192.168.1.20:47900', token: '' });
  });

  it('reports an unreachable server but keeps the saved address', async () => {
    const storage = createInMemoryStorage();
    const { port } = fakeRemote(async () => {
      const error = new Error('no route');
      error.name = 'NetworkError';
      throw error;
    });
    const store = boot(storage, port);
    await store.ready();

    const result = await store.pairFromLink(PHONE_LINK);

    expect(result).toEqual({
      ok: false,
      message: 'Could not reach the download server.',
    });
    expect(store.connection()).toEqual({
      status: 'error',
      message: 'Could not reach the download server.',
    });
    expect(store.downloadServerUrl()).toBe('http://192.168.1.20:47900');
  });
});

describe('SettingsStore crossfade', () => {
  it('is off at 5 s by default and keeps the duration while off', async () => {
    const storage = createInMemoryStorage();
    const store = boot(storage);
    await store.ready();
    expect(store.crossfadeSec()).toBe(0);
    expect(store.crossfadeDurationSec()).toBe(5);

    await store.setCrossfadeDurationSec(8);
    await store.setCrossfadeEnabled(true);
    expect(store.crossfadeSec()).toBe(8);

    await store.setCrossfadeEnabled(false);
    expect(store.crossfadeSec()).toBe(0);
    expect(store.crossfadeDurationSec()).toBe(8);

    // Both survive a reload; turning it back on restores the 8 s.
    const reloaded = boot(storage);
    await reloaded.ready();
    expect(reloaded.crossfadeEnabled()).toBe(false);
    await reloaded.setCrossfadeEnabled(true);
    expect(reloaded.crossfadeSec()).toBe(8);
  });

  it('clamps the duration to 1 to 12 whole seconds and ignores non-numbers', async () => {
    const store = boot(createInMemoryStorage());
    await store.ready();

    await store.setCrossfadeDurationSec(99);
    expect(store.crossfadeDurationSec()).toBe(12);
    await store.setCrossfadeDurationSec(-3);
    expect(store.crossfadeDurationSec()).toBe(1);
    await store.setCrossfadeDurationSec(4.6);
    expect(store.crossfadeDurationSec()).toBe(5);
    await store.setCrossfadeDurationSec(Number.NaN);
    expect(store.crossfadeDurationSec()).toBe(5);
  });

  it('ignores invalid persisted values and clamps out-of-range ones', async () => {
    const storage = createInMemoryStorage();
    await storage.settings.set(SETTINGS_KEYS.crossfade, {
      enabled: 'yes',
      durationSec: 'fast',
    });
    const invalid = boot(storage);
    await invalid.ready();
    expect(invalid.crossfadeEnabled()).toBe(false);
    expect(invalid.crossfadeDurationSec()).toBe(5);

    await storage.settings.set(SETTINGS_KEYS.crossfade, {
      enabled: true,
      durationSec: 40,
    });
    const clamped = boot(storage);
    await clamped.ready();
    expect(clamped.crossfadeSec()).toBe(12);
  });
});
