import { describe, expect, it, vi } from 'vitest';
import { compareVersions, installFailureFrom } from './updater';

vi.mock('electron', () => ({ app: {} }));
vi.mock('electron-updater', () => ({ autoUpdater: {} }));

describe('installFailureFrom', () => {
  const record = (target: string) =>
    JSON.stringify({ target, from: '0.0.4', at: '2026-11-10T00:00:00.000Z' });

  it('reports a failure when the app is still older than the install target', () => {
    expect(installFailureFrom(record('0.0.5'), '0.0.4')).toContain('The update to 0.0.5 did not install.');
  });

  it('reports nothing when the install took effect', () => {
    expect(installFailureFrom(record('0.0.5'), '0.0.5')).toBeNull();
    expect(installFailureFrom(record('0.0.5'), '0.0.6')).toBeNull();
  });

  it('reports nothing without a record or with an unreadable one', () => {
    expect(installFailureFrom(null, '0.0.4')).toBeNull();
    expect(installFailureFrom('not json', '0.0.4')).toBeNull();
    expect(installFailureFrom(JSON.stringify({ target: 'latest' }), '0.0.4')).toBeNull();
  });
});

describe('compareVersions', () => {
  it('orders numeric parts and pre-releases before their release', () => {
    expect(compareVersions('0.0.10', '0.0.9')).toBe(1);
    expect(compareVersions('0.0.4', '0.0.5')).toBe(-1);
    expect(compareVersions('0.0.5-beta.1', '0.0.5')).toBe(-1);
    expect(compareVersions('0.0.5', '0.0.5')).toBe(0);
  });

  it('compares numeric pre-release identifiers as numbers (beta.9 < beta.10)', () => {
    expect(compareVersions('0.0.5-beta.9', '0.0.5-beta.10')).toBe(-1);
    expect(compareVersions('0.0.5-beta.10', '0.0.5-beta.9')).toBe(1);
    expect(compareVersions('0.0.5-beta.2', '0.0.5-beta.1')).toBe(1);
    expect(compareVersions('0.0.5-alpha.1', '0.0.5-beta.1')).toBe(-1);
  });

  it('returns null for anything that is not a plain version', () => {
    expect(compareVersions('v0.0.5', '0.0.5')).toBeNull();
    expect(compareVersions('0.0.5', 'latest')).toBeNull();
  });
});
