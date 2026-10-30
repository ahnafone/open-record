/**
 * Rewrites a request URL so a cast relay token never reaches a log line.
 *
 * The relay route itself is `logLevel: 'silent'`, but the root logger, the
 * rate-limit plugin and error paths can still print `req.url`; this serializer
 * is defence in depth for those.
 */
export function redactRelayUrl(url: string | undefined): string {
  if (!url) return '';
  return url.replace(/\/cast\/relay\/[^/?#]+/g, '/cast/relay/[redacted]');
}
