import type {
  AccessAction,
  AccessRequest,
  AccessStatus,
} from '@open-record/models';

export const STATUS_LABEL: Readonly<Record<AccessStatus, string>> = {
  pending: 'Pending',
  approved: 'Approved',
  denied: 'Denied',
  revoked: 'Revoked',
};

export const ACTION_DONE: Readonly<Record<AccessAction, string>> = {
  approve: 'Access approved',
  deny: 'Access denied',
  revoke: 'Access revoked',
};

const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
const absolute = new Intl.DateTimeFormat('en', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

/** "2 hours ago", "yesterday", "just now". Falls back to an em dash for bad input. */
export function relativeTime(iso: string | null, now = Date.now()): string {
  if (!iso) return '—';
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return '—';
  const seconds = Math.round((at - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 60) return 'just now';
  if (abs < 3600) return relative.format(Math.round(seconds / 60), 'minute');
  if (abs < 86_400) return relative.format(Math.round(seconds / 3600), 'hour');
  if (abs < 30 * 86_400)
    return relative.format(Math.round(seconds / 86_400), 'day');
  return absolute.format(new Date(at));
}

/** Full date and time for the `title` tooltip. */
export function absoluteTime(iso: string | null): string {
  if (!iso) return '';
  const at = Date.parse(iso);
  return Number.isNaN(at) ? '' : absolute.format(new Date(at));
}

/** Newest first by request time. Returns a new array. */
export function newestFirst(list: readonly AccessRequest[]): AccessRequest[] {
  return [...list].sort(
    (a, b) => Date.parse(b.requested_at) - Date.parse(a.requested_at),
  );
}

export function emptyMessage(status: AccessStatus): string {
  switch (status) {
    case 'pending':
      return 'No pending requests. New requests will appear here.';
    case 'approved':
      return 'No approved accounts yet.';
    case 'denied':
      return 'No denied requests.';
    case 'revoked':
      return 'No revoked access.';
  }
}
