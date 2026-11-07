import type { Track } from '@open-record/models';
import {
  AutoDownloadBreaker,
  MAX_SYSTEMIC_STREAK,
  autoDownloadAllowed,
  isDownloadSessionActive,
  nextAutoDownload,
  type AutoDownloadInfo,
} from './auto-download.store';
import { BackgroundWorkHold } from './background-work';

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

  it('skips bad tracks, pauses only on systemic failures, and resets', () => {
    const breaker = new AutoDownloadBreaker();
    // Track failures never pause, however many there are in a row.
    for (let i = 0; i < 200; i++) expect(breaker.record('track')).toBe(false);
    expect(breaker.paused).toBe(false);
    for (let i = 1; i < MAX_SYSTEMIC_STREAK; i++) breaker.record('systemic');
    breaker.record('track'); // the server answered: streak broken
    for (let i = 1; i < MAX_SYSTEMIC_STREAK; i++) breaker.record('systemic');
    expect(breaker.paused).toBe(false);
    expect(breaker.record('systemic', 'Could not reach the download server.')).toBe(true);
    expect(breaker.reason).toBe('Paused: could not reach the download server.');
    expect(breaker.retryDelayMs()).toBeGreaterThan(0);
    breaker.reset();
    expect(breaker.paused).toBe(false);
  });
});

describe('download progress session', () => {
  it('stays active from one auto-save to the next and ends with the run', () => {
    // Song 1 queued and saving.
    expect(
      isDownloadSessionActive({ downloading: 1, runActive: true, runTrackInSet: true, pending: 1 }),
    ).toBe(true);
    // Song 1 saved, song 2 not queued yet: the gap that used to hide the bar.
    expect(
      isDownloadSessionActive({ downloading: 0, runActive: true, runTrackInSet: true, pending: 1 }),
    ).toBe(true);
    // Song 2 queued.
    expect(
      isDownloadSessionActive({ downloading: 1, runActive: true, runTrackInSet: true, pending: 0 }),
    ).toBe(true);
    // Run finished, nothing queued: hides.
    expect(
      isDownloadSessionActive({ downloading: 0, runActive: false, runTrackInSet: false, pending: 0 }),
    ).toBe(false);
    // Run paused with tracks left: hides.
    expect(
      isDownloadSessionActive({ downloading: 0, runActive: false, runTrackInSet: false, pending: 3 }),
    ).toBe(false);
  });
});

describe('background work hold', () => {
  it('starts once when downloads begin, updates the count, stops when idle', async () => {
    const calls: string[] = [];
    const hold = new BackgroundWorkHold({
      start: async (o) => void calls.push(`start:${o.text}`),
      update: async (o) => void calls.push(`update:${o.text}`),
      stop: async () => void calls.push('stop'),
    });
    hold.sync(0);
    hold.sync(3);
    hold.sync(3);
    hold.sync(2);
    hold.sync(0);
    hold.sync(0);
    await hold.settled();
    expect(calls).toEqual([
      'start:Downloading · 3 left',
      'update:Downloading · 2 left',
      'stop',
    ]);
  });
});
