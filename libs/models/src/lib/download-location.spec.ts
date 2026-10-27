import { describe, expect, it } from 'vitest';
import { splitStoredPath, withDownloadLocation } from './download-location';

describe('download location paths', () => {
  it('keeps legacy unprefixed paths in app data and round-trips external', () => {
    expect(splitStoredPath('imported/a.mp3')).toEqual({ location: 'data', path: 'imported/a.mp3' });
    expect(withDownloadLocation('imported/a.mp3', 'data')).toBe('imported/a.mp3');
    const ext = withDownloadLocation('imported/a.mp3', 'external');
    expect(splitStoredPath(ext)).toEqual({ location: 'external', path: 'imported/a.mp3' });
  });
});
