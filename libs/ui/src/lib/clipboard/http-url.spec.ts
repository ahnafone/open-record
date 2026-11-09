import { isHttpUrl } from './http-url';

describe('isHttpUrl', () => {
  it('accepts absolute http and https URLs', () => {
    expect(isHttpUrl('https://example.com/a.mp3')).toBe(true);
    expect(isHttpUrl('http://example.com/a')).toBe(true);
  });

  it('rejects javascript, data, relative, and malformed URLs', () => {
    expect(isHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isHttpUrl('data:audio/mp3;base64,AAAA')).toBe(false);
    expect(isHttpUrl('/music/x.mp3')).toBe(false);
    expect(isHttpUrl('not a url')).toBe(false);
  });
});
