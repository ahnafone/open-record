const DAY_MS = 24 * 60 * 60 * 1000;

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

/** "Member for …" age from an ISO date: days under two months, then months, then years. */
export function accountAge(createdAt: string | undefined, now = Date.now()): string {
  const start = createdAt ? Date.parse(createdAt) : NaN;
  if (Number.isNaN(start)) return '';
  const days = Math.max(0, Math.floor((now - start) / DAY_MS));
  if (days < 1) return 'Less than a day';
  if (days < 60) return plural(days, 'day');
  const months = Math.floor(days / 30.44);
  if (months < 24) return plural(months, 'month');
  return plural(Math.floor(months / 12), 'year');
}

/** Medium date (and optionally time) for an ISO string or epoch ms; '' when unknown. */
export function formatWhen(value: string | number | null | undefined, withTime = false): string {
  if (value === null || value === undefined || value === '') return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(
    undefined,
    withTime ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' },
  );
}
