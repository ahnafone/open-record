import { failureKind } from './remote-errors';

describe('remote error classification', () => {
  // The provider's HttpError is out of reach for state (module boundaries), so
  // mirror what `failureKind` reads: `name === 'HttpError'` and a `status`.
  it('treats age-restricted 502s as per-track failures', () => {
    // Deliberately short fragments: the server's wording may change and only the classifier phrases matter.
    const ageMessages = [
      'Sign in to confirm your age. This video is age-restricted; add YouTube cookies to the server.',
      "This video is age-restricted; the server's cookies file cannot be read.",
      "This video is age-restricted and the server's cookies did not help; they may be stale.",
      "This video is age-restricted; the server could not write a temporary copy of its cookies file.",
    ];
    for (const message of ageMessages) {
      expect(
        failureKind(Object.assign(new Error(message), { name: 'HttpError', status: 502 })),
      ).toBe('track');
    }
  });

  it('still treats a generic 502 as systemic', () => {
    expect(
      failureKind(Object.assign(new Error('yt-dlp failed'), { name: 'HttpError', status: 502 })),
    ).toBe('systemic');
  });
});
