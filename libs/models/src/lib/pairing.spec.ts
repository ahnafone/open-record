import { describe, expect, it } from 'vitest';
import { buildPairingLink, parsePairingLink } from './pairing';

describe('pairing link', () => {
  it('round-trips url and token', () => {
    const link = buildPairingLink({ url: 'http://192.168.1.20:8787', token: 'abc&def=1+2 ok' });
    expect(link.startsWith('openrecord://pair?')).toBe(true);
    expect(parsePairingLink(`  ${link}\n`)).toEqual({ url: 'http://192.168.1.20:8787', token: 'abc&def=1+2 ok' });
  });

  it('rejects bad schemes, hosts and urls', () => {
    expect(parsePairingLink('https://pair?url=http%3A%2F%2Fx&token=t')).toBeNull();
    expect(parsePairingLink('openrecord://other?url=http%3A%2F%2Fx&token=t')).toBeNull();
    expect(parsePairingLink('openrecord://pair?url=ftp%3A%2F%2Fx&token=t')).toBeNull();
    expect(parsePairingLink('openrecord://pair?url=not-a-url&token=t')).toBeNull();
    expect(parsePairingLink('not a link')).toBeNull();
  });

  it('accepts a link without a token (address only)', () => {
    expect(parsePairingLink(buildPairingLink({ url: 'http://x' }))).toEqual({ url: 'http://x', token: '' });
  });
});
