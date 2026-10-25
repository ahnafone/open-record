import { formatBytes } from './format-bytes';

describe('formatBytes', () => {
  it('formats sizes for the storage breakdown', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(NaN)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(12 * 1024 * 1024)).toBe('12 MB');
    expect(formatBytes(3 * 1024 ** 3)).toBe('3 GB');
  });
});
