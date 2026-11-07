import { clientKey } from './client-ip';

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
