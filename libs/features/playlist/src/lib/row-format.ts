let dateFormat: Intl.DateTimeFormat | undefined;

/**
 * Locale date for an epoch-ms timestamp (same output as
 * `toLocaleDateString()`, with one cached formatter); `—` when unknown.
 */
export function formatAddedAt(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return '—';
  dateFormat ??= new Intl.DateTimeFormat();
  return dateFormat.format(ms);
}
