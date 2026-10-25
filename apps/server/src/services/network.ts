import type { NetworkInterfaceInfo } from 'node:os';

export type InterfaceMap = Record<string, NetworkInterfaceInfo[] | undefined>;

export interface PickLanUrlOptions {
  /** `PUBLIC_URL`, used verbatim when set. */
  publicUrl?: string;
  /** Listen host (`HOST`). A specific address is used as-is. */
  host: string;
  port: number;
  interfaces: InterfaceMap;
}

export interface PickedUrl {
  /** The URL to show first (QR code, pairing link). */
  url: string;
  /** Every candidate URL, best first. */
  candidates: string[];
  /** False when no LAN-looking address was found (only docker bridge or none). */
  confident: boolean;
}

const WILDCARD_HOSTS = new Set(['', '0.0.0.0', '::']);

/** First two octets of a dotted IPv4 address, or undefined if it is not one. */
function firstTwoOctets(address: string): [number, number] | undefined {
  const match = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(address);
  return match ? [Number(match[1]), Number(match[2])] : undefined;
}

/** 172.16.0.0/12: Docker's default bridge range. Rarely reachable from a phone. */
function isDockerBridge(address: string): boolean {
  const o = firstTwoOctets(address);
  return !!o && o[0] === 172 && o[1] >= 16 && o[1] <= 31;
}

/** 100.64.0.0/10: carrier-grade NAT, also used by Tailscale. */
function isCgnat(address: string): boolean {
  const o = firstTwoOctets(address);
  return !!o && o[0] === 100 && o[1] >= 64 && o[1] <= 127;
}

/** Lower is better: ordinary LAN first, CGNAT next, Docker bridge last. */
function rank(address: string): number {
  if (isDockerBridge(address)) return 2;
  if (isCgnat(address)) return 1;
  return 0;
}

/** Non-internal IPv4 addresses, best first. */
export function listLanAddresses(interfaces: InterfaceMap): string[] {
  const found: string[] = [];
  for (const infos of Object.values(interfaces)) {
    for (const info of infos ?? []) {
      const family: unknown = info.family;
      if (info.internal) continue;
      if (family !== 'IPv4' && family !== 4) continue;
      found.push(info.address);
    }
  }
  return found
    .map((address, index) => ({ address, index }))
    .sort((a, b) => rank(a.address) - rank(b.address) || a.index - b.index)
    .map((entry) => entry.address);
}

/**
 * Chooses the URL phones should use: `PUBLIC_URL` verbatim, else a specific
 * `HOST`, else the best non-internal IPv4 address on this machine.
 */
export function pickLanUrl(options: PickLanUrlOptions): PickedUrl {
  const { port, interfaces } = options;
  const publicUrl = options.publicUrl?.trim();
  if (publicUrl) {
    return { url: publicUrl, candidates: [publicUrl], confident: true };
  }

  const host = options.host.trim();
  if (!WILDCARD_HOSTS.has(host)) {
    const url = `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
    return { url, candidates: [url], confident: true };
  }

  const addresses = listLanAddresses(interfaces);
  const candidates = addresses.map((a) => `http://${a}:${port}`);
  const [best] = addresses;
  const [url] = candidates;
  if (best === undefined || url === undefined) {
    const loopback = `http://127.0.0.1:${port}`;
    return { url: loopback, candidates: [loopback], confident: false };
  }
  return { url, candidates, confident: rank(best) < 2 };
}
