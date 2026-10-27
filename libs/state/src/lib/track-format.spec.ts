import { downloadState, formatAddedAt, formatDuration, sourceLabel } from './track-format';

describe('track row format', () => {
  it('formats durations and hides unknown ones', () => {
    expect(formatDuration(65)).toBe('1:05');
    expect(formatDuration(3725)).toBe('1:02:05');
    expect(formatDuration(undefined)).toBe('');
    expect(formatDuration(0)).toBe('');
    expect(formatAddedAt(undefined)).toBe('—');
  });

  it('labels sources and download states', () => {
    expect(sourceLabel('ytmusic')).toBe('YT Music');
    expect(sourceLabel('web')).toBe('Link');
    expect(sourceLabel(undefined)).toBeNull();
    expect(downloadState('saving')?.label).toBe('Downloading');
    expect(downloadState('failed')?.kind).toBe('failed');
    expect(downloadState(undefined)).toBeNull();
    expect(downloadState('failed')?.label).toBe('Failed');
    expect(
      downloadState('failed', 'Server error: ERROR: [youtube] x: Sign in to confirm your age')?.label,
    ).toBe('Age-restricted');
    expect(downloadState('failed', 'Server is busy, try again in 5s.')?.label).toBe('Server busy');
  });
});
