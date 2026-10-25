// Pairing payload shared by the download server (QR / banner) and the app
// (scan + paste). Format: openrecord://pair?url=<enc>&token=<enc>

export interface PairingPayload {
  url: string;
  token: string;
}

const PAIRING_SCHEME = 'openrecord:';
const PAIRING_HOST = 'pair';

export function buildPairingLink({ url, token }: PairingPayload): string {
  return `openrecord://${PAIRING_HOST}?url=${encodeURIComponent(url)}&token=${encodeURIComponent(token)}`;
}

/**
 * Parses a pairing link. Returns null unless the input is an `openrecord://pair`
 * link with an http/https `url` and a non-empty `token`.
 */
export function parsePairingLink(text: string): PairingPayload | null {
  const input = text.trim();
  if (!input) return null;

  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return null;
  }
  if (parsed.protocol !== PAIRING_SCHEME || parsed.host !== PAIRING_HOST) return null;

  const url = parsed.searchParams.get('url')?.trim() ?? '';
  const token = parsed.searchParams.get('token')?.trim() ?? '';
  if (!token) return null;

  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return null;
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return null;

  return { url, token };
}
