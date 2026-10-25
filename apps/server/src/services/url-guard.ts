import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

/** Longest URL the server will hand to yt-dlp. */
export const MAX_URL_LENGTH = 2048;

/** Thrown when a URL is not allowed; the message is safe to return to the client. */
export class UrlRejectedError extends Error {}

export type LookupFn = (hostname: string) => Promise<string[]>;

const defaultLookup: LookupFn = async (hostname) =>
  (await dnsLookup(hostname, { all: true, verbatim: true })).map((a) => a.address);

/** Private, loopback, link-local, metadata, CGNAT, multicast and reserved ranges. */
const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, includes 169.254.169.254 cloud metadata
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96], // NAT64 can reach IPv4 private space
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001:db8::', 32],
  ['2002::', 16], // 6to4 embeds arbitrary IPv4
  ['fc00::', 7], // unique local, includes fd00:ec2::254 metadata
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv6');
}

/** True when `address` is an IP the server must never fetch from. */
export function isBlockedAddress(address: string): boolean {
  let ip = address.toLowerCase();
  // IPv4-mapped / compatible IPv6 (::ffff:10.0.0.1) is checked as IPv4.
  const mapped = /^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (mapped) ip = mapped[1];
  const family = isIP(ip);
  if (family === 4) return blocked.check(ip, 'ipv4');
  if (family === 6) {
    // ::ffff:a00:1 (hex form of a mapped IPv4) is also loopback/private territory.
    if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(ip)) return true;
    return blocked.check(ip, 'ipv6');
  }
  return true; // not an IP at all: refuse
}

/**
 * Validates a user-supplied URL before it reaches yt-dlp: http(s) only, no
 * credentials, length cap, and every address the hostname resolves to must be
 * public (SSRF guard). Returns the normalised URL string.
 *
 * Note: yt-dlp follows redirects and resolves DNS again itself, so this does
 * not stop DNS rebinding; it blocks the direct cases.
 */
export async function validateUrl(raw: unknown, lookup: LookupFn = defaultLookup): Promise<string> {
  if (typeof raw !== 'string' || !raw.trim()) throw new UrlRejectedError('url is required');
  const input = raw.trim();
  if (input.length > MAX_URL_LENGTH) throw new UrlRejectedError('url is too long');

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new UrlRejectedError('url is not valid');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UrlRejectedError('only http and https urls are allowed');
  }
  if (url.username || url.password) throw new UrlRejectedError('urls with credentials are not allowed');

  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new UrlRejectedError('url host is not allowed');
  }

  let addresses: string[];
  if (isIP(host)) {
    addresses = [host];
  } else {
    try {
      addresses = await lookup(host);
    } catch {
      throw new UrlRejectedError('url host could not be resolved');
    }
  }
  if (!addresses.length || addresses.some(isBlockedAddress)) {
    throw new UrlRejectedError('url host is not allowed');
  }
  return url.toString();
}
