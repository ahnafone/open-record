import { buildPairingLink } from '@open-record/models';
import QRCode from 'qrcode';
import type { ResolvedToken } from './token-store';

/** Printed once the server listens. Also used by scripts/server-up.mjs to find the banner. */
export const BANNER_MARKER = 'Open Record server is ready';

export interface BannerOptions {
  /** Primary URL phones should use. */
  url: string;
  /** Every candidate URL, best first (includes `url`). */
  candidates: string[];
  /** False when only a loopback or container address was found. */
  confident: boolean;
  /** True when PUBLIC_URL was set, so the URL is already the right one. */
  fromPublicUrl: boolean;
  token: ResolvedToken;
}

function tokenNote(token: ResolvedToken): string {
  switch (token.source) {
    case 'env':
      return 'from OPEN_RECORD_TOKEN';
    case 'file':
      return `saved in ${token.path}`;
    case 'generated':
      return `generated and saved to ${token.path}`;
  }
}

/** Startup banner: URLs, token, pairing link and a terminal QR code. */
export async function formatBanner(options: BannerOptions): Promise<string> {
  const { url, candidates, token } = options;
  const pairing = buildPairingLink({ url, token: token.token });
  const qr = await QRCode.toString(pairing, { type: 'terminal', small: true });

  const lines = [
    `${BANNER_MARKER}.`,
    '',
    `  URL:      ${url}`,
    ...candidates.slice(1).map((other) => `  Also:     ${other}`),
    `  Token:    ${token.token}  (${tokenNote(token)})`,
    `  Pairing:  ${pairing}`,
    '',
    'In the app: Settings > Download server > Scan QR code (or paste the pairing link).',
    'Keep the token private: anyone with it can use this server.',
  ];
  if (!options.confident && !options.fromPublicUrl) {
    lines.push(
      '',
      'Only a container or loopback address was found, so phones cannot reach it.',
      'Start from the repository root with "npm run server:up" to publish on your LAN address.',
    );
  }
  return `${lines.join('\n')}\n\n${qr.trimEnd()}\n`;
}
