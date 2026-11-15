import { failureKind, remoteErrorMessage } from './remote-errors';

describe('remote error copy for guests', () => {
  it('explains a refused guest host and points to sign-in', () => {
    const err = Object.assign(new Error('refused'), { name: 'guest_host_not_allowed' });
    expect(remoteErrorMessage(err)).toBe(
      'Guests can only play links from YouTube, SoundCloud and Bandcamp. Sign in to continue.',
    );
  });

  it('gives a retry hint for a busy guest share, and keeps the plain busy copy otherwise', () => {
    const guest = Object.assign(new Error('busy'), { name: 'busy', code: 'guest_busy', retryAfterSec: 5 });
    expect(remoteErrorMessage(guest)).toBe('Guest streaming is busy right now, try again in 5s. Sign in to keep going.');
    const plain = Object.assign(new Error('busy'), { name: 'busy' });
    expect(remoteErrorMessage(plain)).toBe('Server is busy, try again in a moment.');
  });
});

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

  it('treats a generic yt-dlp 422 as systemic, not a per-track failure', () => {
    expect(
      failureKind(Object.assign(new Error('yt-dlp failed'), { name: 'HttpError', status: 422 })),
    ).toBe('systemic');
    expect(
      failureKind(Object.assign(new Error('yt-dlp timed out'), { name: 'HttpError', status: 408 })),
    ).toBe('systemic');
  });

  it('keeps age-locked 422s per-track', () => {
    expect(
      failureKind(
        Object.assign(new Error('Sign in to confirm your age. Add cookies to retry.'), {
          name: 'HttpError',
          status: 422,
        }),
      ),
    ).toBe('track');
  });

  it('treats a bot check as systemic even though it is a 4xx', () => {
    expect(
      failureKind(
        Object.assign(new Error("Sign in to confirm you're not a bot."), {
          name: 'HttpError',
          status: 422,
        }),
      ),
    ).toBe('systemic');
  });

  it('keeps the server\'s segmented-link 422 per-track', () => {
    expect(
      failureKind(
        Object.assign(
          new Error('this source only offers segmented streams, which are not supported'),
          { name: 'HttpError', status: 422 },
        ),
      ),
    ).toBe('track');
  });

  it('keeps a plain 404 per-track and a 5xx systemic', () => {
    expect(
      failureKind(Object.assign(new Error('missing'), { name: 'HttpError', status: 404 })),
    ).toBe('track');
    expect(
      failureKind(Object.assign(new Error('boom'), { name: 'HttpError', status: 500 })),
    ).toBe('systemic');
  });
});
