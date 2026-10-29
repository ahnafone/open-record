import { SETTINGS_KEYS, createInMemoryStorage } from '@open-record/storage';
import {
  defaultDeviceName,
  ensureClientId,
  ensureDeviceId,
} from './device-identity';

describe('device identity', () => {
  it('persists one device id across calls', async () => {
    const storage = createInMemoryStorage();
    const first = await ensureDeviceId(storage);
    expect(first).toBeTruthy();
    expect(await ensureDeviceId(storage)).toBe(first);
    expect(await storage.settings.get(SETTINGS_KEYS.deviceId)).toBe(first);
  });

  it('returns a stored id trimmed', async () => {
    const storage = createInMemoryStorage();
    await storage.settings.set(SETTINGS_KEYS.deviceId, '  existing-id  ');
    expect(await ensureDeviceId(storage)).toBe('existing-id');
  });

  it('generates a different id after app data is cleared', async () => {
    const storage = createInMemoryStorage();
    const first = await ensureDeviceId(storage);
    await storage.clearAll();
    const second = await ensureDeviceId(storage);
    expect(second).not.toBe(first);
    expect(await storage.settings.get(SETTINGS_KEYS.deviceId)).toBe(second);
  });

  it('keeps one id after a write fails and reads start working again', async () => {
    const readOkWriteFails = {
      settings: {
        get: async () => undefined,
        set: async () => {
          throw new Error('write failed');
        },
        delete: async () => undefined,
      },
    };
    const first = await ensureDeviceId(readOkWriteFails);
    expect(first).toBeTruthy();
    expect(await ensureDeviceId(readOkWriteFails)).toBe(first);
  });

  it('uses a stable in-memory fallback only when storage fails', async () => {
    const broken = {
      settings: {
        get: async () => {
          throw new Error('read failed');
        },
        set: async () => {
          throw new Error('write failed');
        },
        delete: async () => undefined,
      },
    };
    const first = await ensureDeviceId(broken);
    expect(first).toBeTruthy();
    expect(await ensureDeviceId(broken)).toBe(first);
  });

  it('never persists the per-instance client id', () => {
    const first = ensureClientId();
    const second = ensureClientId();
    expect(first).toBeTruthy();
    expect(second).not.toBe(first);
  });
});

describe('defaultDeviceName', () => {
  it('is platform-aware and never too long', () => {
    const cases: Array<[string, string, string]> = [
      ['Mozilla/5.0 (Linux; Android 14; Pixel 8)', 'Linux armv8l', 'Android'],
      [
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
        'iPhone',
        'iPhone',
      ],
      ['Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)', 'iPad', 'iPad'],
      ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'MacIntel', 'Mac'],
      ['Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Win32', 'Windows'],
      ['Mozilla/5.0 (X11; Linux x86_64)', 'Linux x86_64', 'Linux'],
    ];
    for (const [userAgent, platform, expected] of cases) {
      const name = defaultDeviceName({ userAgent, platform });
      expect(name).toContain(expected);
      expect(name.length).toBeLessThanOrEqual(60);
    }
    expect(
      defaultDeviceName({ userAgent: 'Something else', platform: '' }),
    ).toBe('Web browser');
    expect(defaultDeviceName().length).toBeLessThanOrEqual(60);
  });
});
