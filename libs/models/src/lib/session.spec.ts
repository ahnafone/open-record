import { describe, expect, it, vi } from 'vitest';
import type { SessionTarget } from './session';
import {
  anchoredPosition,
  clampCursor,
  isThisClient,
  joinUrl,
  newClientId,
  newEntryId,
  nextCursor,
  previousCursor,
} from './session';

describe('newEntryId', () => {
  it('prefers randomUUID when available', () => {
    vi.stubGlobal('crypto', { randomUUID: () => 'stubbed-uuid' });
    try {
      expect(newEntryId()).toBe('stubbed-uuid');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('falls back to 16 random bytes as lowercase hex when randomUUID is missing', () => {
    vi.stubGlobal('crypto', {
      getRandomValues: (bytes: Uint8Array) => {
        bytes.fill(0x0a);
        return bytes;
      },
    });
    try {
      expect(newEntryId()).toBe('0a'.repeat(16));
      expect(newClientId()).toBe('0a'.repeat(16));
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('clampCursor', () => {
  it('returns -1 when there is nothing valid to select', () => {
    expect(clampCursor(0, 0)).toBe(-1);
    expect(clampCursor(5, -1)).toBe(-1);
    expect(clampCursor(5, Number.NaN)).toBe(-1);
    expect(clampCursor(5, Number.POSITIVE_INFINITY)).toBe(-1);
  });

  it('truncates and caps the cursor to the queue', () => {
    expect(clampCursor(5, 2.9)).toBe(2);
    expect(clampCursor(5, 5)).toBe(4);
    expect(clampCursor(5, 10)).toBe(4);
  });
});

describe('anchoredPosition', () => {
  it('extrapolates a playing state and holds a paused one', () => {
    const state = { positionSec: 10, playing: true, updatedAt: 1_000 };
    expect(anchoredPosition(state, 3_500)).toBe(12.5);
    expect(anchoredPosition({ ...state, playing: false }, 3_500)).toBe(10);
    expect(anchoredPosition(state, 500)).toBe(10);
  });

  it('never returns a negative position', () => {
    expect(anchoredPosition({ positionSec: -5, playing: false, updatedAt: 0 }, 10_000)).toBe(0);
  });
});

describe('nextCursor', () => {
  it('advances on a natural end and on a manual next', () => {
    expect(nextCursor(1, 3, 'off', true)).toBe(2);
    expect(nextCursor(1, 3, 'off', false)).toBe(2);
  });

  it('restarts repeat-one only on a natural end', () => {
    expect(nextCursor(1, 3, 'one', true)).toBe(1);
    expect(nextCursor(1, 3, 'one', false)).toBe(2);
  });

  it('wraps with repeat-all and stops at the end with repeat-off', () => {
    expect(nextCursor(2, 3, 'all', true)).toBe(0);
    expect(nextCursor(2, 3, 'off', true)).toBe(2);
    expect(nextCursor(2, 3, 'off', false)).toBe(2);
  });

  it('handles an empty queue and an out-of-range cursor', () => {
    expect(nextCursor(0, 0, 'all', true)).toBe(-1);
    expect(nextCursor(9, 3, 'all', false)).toBe(0);
  });
});

describe('previousCursor', () => {
  it('restarts the entry past the 3s boundary', () => {
    expect(previousCursor(1, 3, 3)).toEqual({ cursor: 0, restart: false });
    expect(previousCursor(1, 3, 3.01)).toEqual({ cursor: 1, restart: true });
  });

  it('moves to the previous entry in the middle of the queue', () => {
    expect(previousCursor(1, 3, 1)).toEqual({ cursor: 0, restart: false });
  });

  it('restarts the first entry', () => {
    expect(previousCursor(0, 3, 1)).toEqual({ cursor: 0, restart: true });
  });

  it('returns no cursor for an empty queue', () => {
    expect(previousCursor(0, 0, 1)).toEqual({ cursor: -1, restart: false });
  });
});

describe('isThisClient', () => {
  it('distinguishes two clients that share one deviceId', () => {
    const tabA: SessionTarget = { kind: 'device', clientId: 'client-a', deviceId: 'device-1' };
    const tabB: SessionTarget = { kind: 'device', clientId: 'client-b', deviceId: 'device-1' };
    expect(isThisClient(tabA, 'client-a')).toBe(true);
    expect(isThisClient(tabA, 'client-b')).toBe(false);
    expect(isThisClient(tabB, 'client-b')).toBe(true);
  });

  it('is false for a cast target or no target', () => {
    expect(isThisClient({ kind: 'cast', castId: 'cast-1' }, 'client-a')).toBe(false);
    expect(isThisClient(null, 'client-a')).toBe(false);
  });
});

describe('joinUrl', () => {
  it('trims duplicate slashes around the join', () => {
    expect(joinUrl('http://host:8787/', '/session')).toBe('http://host:8787/session');
    expect(joinUrl('http://host:8787/api//', '//cast/relay')).toBe(
      'http://host:8787/api/cast/relay',
    );
  });

  it('handles an empty base or path', () => {
    expect(joinUrl('', '/session')).toBe('session');
    expect(joinUrl('http://host:8787/', '')).toBe('http://host:8787/');
    expect(joinUrl('', '')).toBe('');
  });
});
