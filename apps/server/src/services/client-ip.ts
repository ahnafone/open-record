import type { IncomingHttpHeaders } from 'node:http';
import { isIP } from 'node:net';

const IPV4_MAPPED = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;
const IPV4_TAIL = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** Minimal shape of a request: what `clientAddress` reads. */
export interface AddressedRequest {
  ip: string;
  headers: IncomingHttpHeaders;
  socket: { remoteAddress?: string | undefined };
}

/** True for IPv4 127.0.0.0/8, IPv6 ::1 and their IPv4-mapped forms. */
function isLoopback(address: string): boolean {
  const mapped = IPV4_MAPPED.exec(address);
  const v4 = mapped?.[1] ?? address;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4)) return true;
  return v4 === '::1';
}

/**
 * Whether the `CF-Connecting-IP` header may name the client. Off by default: only enable
 * (TRUST_CF_CONNECTING_IP=true) when a proxy that overwrites that header is the sole path to the origin.
 * Set once by `buildApp` from config; module state, like `configureResolveLimits`.
 */
let trustCfConnectingIp = false;

export function configureClientIp(options: { trustCfConnectingIp: boolean }): void {
  trustCfConnectingIp = options.trustCfConnectingIp;
}

/**
 * The address a client is counted under. Behind a same-host reverse proxy every
 * request arrives from loopback (the proxy), so `request.ip` is 127.0.0.1 and
 * all users would share one budget. When `trustCfConnectingIp` is enabled and
 * the TCP peer is loopback (the local proxy) with a valid IP in
 * `CF-Connecting-IP` (overwritten by that proxy), that header is used. A
 * non-loopback peer never gets this treatment, so it cannot spoof its address.
 * Otherwise `request.ip` (TRUST_PROXY) applies, exactly as before.
 */
export function clientAddress(request: AddressedRequest): string {
  if (trustCfConnectingIp) {
    const peer = request.socket.remoteAddress ?? '';
    const header = request.headers['cf-connecting-ip'];
    if (typeof header === 'string' && isLoopback(peer)) {
      const ip = header.trim();
      if (isIP(ip)) return ip;
    }
  }
  return request.ip;
}

/**
 * Expands an IPv6 address to its eight 16-bit groups. A dotted IPv4 tail is
 * rewritten as two hex groups first, so `::` is expanded over the whole address.
 */
function ipv6Groups(ip: string): string[] {
  let text = ip;
  const tail = IPV4_TAIL.exec(text);
  if (tail) {
    const [a = 0, b = 0, c = 0, d = 0] = tail.slice(1, 5).map(Number);
    text =
      text.slice(0, tail.index) +
      `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split('::');
  const side = (s: string): string[] => (s ? s.split(':') : []);
  let groups: string[];
  if (halves.length === 2) {
    const head = side(halves[0] ?? '');
    const rest = side(halves[1] ?? '');
    const fill = Math.max(0, 8 - head.length - rest.length);
    groups = [...head, ...Array<string>(fill).fill('0'), ...rest];
  } else {
    groups = side(text);
  }
  return groups.map((group) => group.toLowerCase().padStart(4, '0')).slice(0, 8);
}

/**
 * The key a client is counted under. IPv4 (and IPv4-mapped IPv6) is used as
 * is. An IPv6 client is counted per /64 prefix, since one host usually holds a
 * whole /64 and could otherwise rotate addresses to dodge a per-address budget.
 */
export function clientKey(ip: string): string {
  const mapped = IPV4_MAPPED.exec(ip);
  if (mapped?.[1]) return mapped[1];
  if (isIP(ip) !== 6) return ip;
  return `${ipv6Groups(ip).slice(0, 4).join(':')}::/64`;
}
