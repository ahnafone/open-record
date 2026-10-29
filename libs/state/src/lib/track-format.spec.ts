import {
  AGE_RESTRICTED_REASON,
  downloadState,
  failureReason,
  formatAddedAt,
  formatDuration,
  sourceLabel,
} from './track-format';

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

  it('labels every age-restricted hint as age-restricted, and keeps private video', () => {
    // Deliberately short fragments: the server's wording may change and only the classifier phrases matter.
    const ageMessages = [
      'Sign in to confirm your age. This video is age-restricted; add YouTube cookies to the server.',
      "This video is age-restricted; the server's cookies file cannot be read.",
      "This video is age-restricted and the server's cookies did not help; they may be stale.",
      "This video is age-restricted; the server could not write a temporary copy of its cookies file.",
    ];
    for (const message of ageMessages) {
      expect(failureReason(message)).toBe(AGE_RESTRICTED_REASON);
      expect(downloadState('failed', message)?.label).toBe(AGE_RESTRICTED_REASON);
    }
    expect(
      failureReason(
        "ERROR: [youtube] x: Private video. Sign in if you've been granted access to this video",
      ),
    ).toBe('Private video');
  });
});
