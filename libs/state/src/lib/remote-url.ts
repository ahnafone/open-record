/**
 * Ingest rules for URLs that arrive from another device or the server (session
 * wire, account sync). A remote record is untrusted: only the schemes the app
 * itself produces are kept, everything else (`javascript:`, `data:`, `file:`,
 * `blob:`, `capacitor:`, protocol-relative or absolute device paths) is dropped.
 */

const HTTP_URL = /^https?:\/\/\S+$/i;

/**
 * The bundled catalog's art (`catalog/art/<file>`), resolved against the app
 * itself. Simple file names only: no scheme, no leading slash, no dot-leading
 * name, no `..` anywhere.
 */
const BUNDLED_CATALOG_ART = /^catalog\/art\/(?!\.)(?!.*\.\.)[\w.-]+$/;

/** A remote page link (`source.url`, `sourceUrl`): http(s) only, else undefined. */
export function remoteHttpUrl(value: unknown): string | undefined {
  return typeof value === 'string' && HTTP_URL.test(value) ? value : undefined;
}

/** Cover art from a remote record: http(s) or bundled catalog art, else undefined. */
export function remoteArtUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return HTTP_URL.test(value) || BUNDLED_CATALOG_ART.test(value)
    ? value
    : undefined;
}
