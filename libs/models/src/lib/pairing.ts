// Pairing payload shared by the download server (QR / banner) and the app
// (scan + paste). Format: openrecord://pair?url=<enc>[&token=<enc>]
// The app only uses the server address; users sign in with their account.

export interface PairingPayload {
  url: string;
  /** Legacy static token; optional ('' when absent). The app ignores it. */
  token?: string;
}

const PAIRING_SCHEME = 'openrecord:';
const PAIRING_HOST = 'pair';

export function buildPairingLink({ url, token }: PairingPayload): string {
  const base = `openrecord://${PAIRING_HOST}?url=${encodeURIComponent(url)}`;
  return token ? `${base}&token=${encodeURIComponent(token)}` : base;
}

/**
 * Parses a pairing link. Returns null unless the input is an `openrecord://pair`
 * link with an http/https `url`. `token` is '' when the link has none.
 */
export function parsePairingLink(text: string): { url: string; token: string } | null {
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
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return null;
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return null;

  return { url, token };
}
