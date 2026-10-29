import { TestBed } from '@angular/core/testing';
import {
  SETTINGS_KEYS,
  StoragePort,
  createInMemoryStorage,
  type JsonValue,
  type SettingsRepository,
} from '@open-record/storage';
import { defaultDeviceName, ensureDeviceId } from './device-identity';
import { SettingsStore } from './settings.store';

function boot(storage: StoragePort): SettingsStore {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [{ provide: StoragePort, useValue: storage }],
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
