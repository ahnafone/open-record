import type { Track } from '@open-record/models';
import {
  autoDownloadAllowed,
  nextAutoDownload,
  type AutoDownloadInfo,
} from './auto-download.store';

const remote = (key: string): Track => ({
  id: `remote:${key}`,
  providerId: 'remote',
  title: key,
  artist: 'Artist',
  source: { site: 'youtube', url: `https://www.youtube.com/watch?v=${key}` },
});

describe('auto-download gating', () => {
  it('runs on Wi-Fi only unless mobile data is allowed, never offline', () => {
    const wifi = { connected: true, connectionType: 'wifi' } as const;
    const cell = { connected: true, connectionType: 'cellular' } as const;
    const off = { connected: false, connectionType: 'none' } as const;
    expect(autoDownloadAllowed(wifi, false)).toBe(true);
    expect(autoDownloadAllowed(cell, false)).toBe(false);
    expect(autoDownloadAllowed(cell, true)).toBe(true);
    expect(autoDownloadAllowed(off, true)).toBe(false);
  });

  it('picks only unsaved, uncancelled, unattempted savable tracks', () => {
    const info: Record<string, AutoDownloadInfo> = {
      'remote:saved': { track: remote('saved'), status: 'saved', error: undefined },
      'remote:cancelled': { track: remote('cancelled'), status: 'failed', error: 'Cancelled.' },
      'local:x': {
        track: { id: 'local:x', providerId: 'local', title: 'x', artist: 'A' },
        status: undefined,
        error: undefined,
      },
      'remote:tried': { track: remote('tried'), status: undefined, error: undefined },
      'remote:failed': { track: remote('failed'), status: 'failed', error: 'Network' },
    };
    const wanted = Object.keys(info);
    const pick = (attempted: string[]) =>
      nextAutoDownload(wanted, (id) => info[id], new Set(attempted));
    expect(pick(['remote:tried'])).toBe('remote:failed');
    expect(pick(['remote:tried', 'remote:failed'])).toBeUndefined();
  });
});
