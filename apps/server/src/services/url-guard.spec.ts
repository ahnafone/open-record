import {
  guestHostRefused,
  UrlRejectedError,
  validateUrl,
  validateUrlString,
  type LookupFn,
} from './url-guard';

const publicLookup: LookupFn = async () => ['8.8.8.8', '2606:4700::1111'];

describe('guestHostRefused', () => {
  const allowed = ['youtube.com', 'youtu.be', 'music.youtube.com', 'soundcloud.com', 'bandcamp.com'];

  it.each([
    ['https://evil.example/track.mp3', 'another host'],
    ['https://youtube.com.evil.example/watch?v=x', 'lookalike suffix'],
    ['https://notyoutube.com/watch?v=x', 'lookalike prefix'],
    ['https://youtube.com@evil.example/watch?v=x', 'userinfo trick'],
    ['https://evil.example/?next=youtube.com', 'allowed name only in the query'],
    ['https://уoutube.com/watch?v=x', 'IDN homoglyph (Cyrillic у)'],
  ])('refuses %s (%s)', (url) => {
    expect(guestHostRefused(url, allowed)).toBe(true);
  });

  it.each([
    ['https://YOUTUBE.com/watch?v=x', 'uppercase host'],
    ['https://youtube.com./watch?v=x', 'trailing dot'],
    ['https://m.youtube.com/watch?v=x', 'subdomain'],
    ['https://youtu.be/x', 'short link'],
  ])('allows %s (%s)', (url) => {
    expect(guestHostRefused(url, allowed)).toBe(false);
  });

  it('does not refuse a bare path, which the URL validation then rejects before any fetch', async () => {
    expect(guestHostRefused('youtube.com/watch?v=x', allowed)).toBe(false);
    await expect(validateUrlString('youtube.com/watch?v=x')).rejects.toThrow(UrlRejectedError);
  });
});

describe('validateUrl', () => {
  it('returns the normalised URL and every vetted address', async () => {
    await expect(validateUrl('https://Example.COM/a?b=1', publicLookup)).resolves.toEqual({
      url: 'https://example.com/a?b=1',
      addresses: ['8.8.8.8', '2606:4700::1111'],
    });
  });

  it('returns the literal IP as the vetted address without a lookup', async () => {
    const lookup = vi.fn(async () => ['8.8.8.8']);
    await expect(validateUrl('https://1.1.1.1/x', lookup)).resolves.toEqual({
      url: 'https://1.1.1.1/x',
      addresses: ['1.1.1.1'],
    });
    expect(lookup).not.toHaveBeenCalled();
  });

  it('validateUrlString returns only the normalised URL', async () => {
    await expect(validateUrlString('https://Example.com/x', publicLookup)).resolves.toBe(
      'https://example.com/x',
    );
  });

  it('still throws for a hostname that resolves to a blocked address', async () => {
    await expect(
      validateUrl('https://evil.example/', async () => ['8.8.8.8', '10.0.0.5']),
    ).rejects.toBeInstanceOf(UrlRejectedError);
    await expect(validateUrlString('https://evil.example/', async () => ['169.254.169.254'])).rejects.toThrow(
      /not allowed/,
    );
  });

  it('still rejects unresolvable hosts and non-http URLs', async () => {
    await expect(
      validateUrl('https://nope.example/', async () => {
        throw new Error('ENOTFOUND');
      }),
    ).rejects.toThrow(/could not be resolved/);
    await expect(validateUrl('file:///etc/passwd', publicLookup)).rejects.toThrow(
      /only http and https/,
    );
    await expect(validateUrlString('http://localhost:8787/', publicLookup)).rejects.toThrow(
      /not allowed/,
    );
  });
});
