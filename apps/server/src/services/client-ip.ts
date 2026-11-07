import { isIP } from 'node:net';

const IPV4_MAPPED = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;
const IPV4_TAIL = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

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
