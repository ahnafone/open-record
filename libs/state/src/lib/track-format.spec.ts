import { downloadState, formatDuration, sourceLabel } from './track-format';

describe('track row format', () => {
  it('formats durations and hides unknown ones', () => {
    expect(formatDuration(65)).toBe('1:05');
    expect(formatDuration(3725)).toBe('1:02:05');
    expect(formatDuration(undefined)).toBe('');
    expect(formatDuration(0)).toBe('');
  });

  it('labels sources and download states', () => {
    expect(sourceLabel('ytmusic')).toBe('YT Music');
    expect(sourceLabel('web')).toBe('Link');
    expect(sourceLabel(undefined)).toBeNull();
    expect(downloadState('saving')?.label).toBe('Downloading');
    expect(downloadState('failed')?.kind).toBe('failed');
    expect(downloadState(undefined)).toBeNull();
  });
});
