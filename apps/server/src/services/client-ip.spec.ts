import { clientAddress, clientKey, configureClientIp } from './client-ip';

describe('clientAddress CF-Connecting-IP', () => {
  const request = (peer: string, cf?: string) => ({
    ip: '127.0.0.1',
    socket: { remoteAddress: peer },
    headers: cf === undefined ? {} : { 'cf-connecting-ip': cf },
  });

  afterEach(() => configureClientIp({ trustCfConnectingIp: false }));

  it('ignores CF-Connecting-IP when the flag is off (default)', () => {
    expect(clientAddress(request('127.0.0.1', '203.0.113.7'))).toBe('127.0.0.1');
  });

  it('ignores CF-Connecting-IP from a non-loopback peer even when on', () => {
    configureClientIp({ trustCfConnectingIp: true });
    expect(clientAddress(request('198.51.100.9', '203.0.113.7'))).toBe('127.0.0.1');
  });

  it('ignores an invalid CF-Connecting-IP even when on', () => {
    configureClientIp({ trustCfConnectingIp: true });
    expect(clientAddress(request('127.0.0.1', 'not-an-ip'))).toBe('127.0.0.1');
    expect(clientAddress(request('127.0.0.1', '203.0.113.7, 10.0.0.1'))).toBe('127.0.0.1');
  });

  it('honours a valid CF-Connecting-IP from loopback when on', () => {
    configureClientIp({ trustCfConnectingIp: true });
    expect(clientAddress(request('127.0.0.1', '203.0.113.7'))).toBe('203.0.113.7');
    expect(clientAddress(request('::1', ' 2001:db8::5 '))).toBe('2001:db8::5');
  });
});

describe('clientKey', () => {
  it.each([
    ['203.0.113.7', '203.0.113.7'],
    ['::ffff:203.0.113.7', '203.0.113.7'],
    ['::1', '0000:0000:0000:0000::/64'],
    ['::', '0000:0000:0000:0000::/64'],
    ['2001:db8::1', '2001:0db8:0000:0000::/64'],
    ['64:ff9b::1.2.3.4', '0064:ff9b:0000:0000::/64'],
  ])('keys %s as %s', (ip, expected) => {
    expect(clientKey(ip)).toBe(expected);
  });

  it('gives two addresses in the same /64 one key', () => {
    expect(clientKey('2001:db8:0:1::1')).toBe(clientKey('2001:db8:0:1:ffff::2'));
  });

  it('gives addresses in different /64s different keys', () => {
    expect(clientKey('2001:db8:0:1::1')).not.toBe(clientKey('2001:db8:0:2::1'));
  });
});
