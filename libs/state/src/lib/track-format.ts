import type { OfflineStatus } from './offline.store';

/** `m:ss` (or `h:mm:ss`) for a duration in seconds; `''` when unknown. */
export function formatDuration(sec: number | undefined): string {
  if (!sec || sec < 0 || !Number.isFinite(sec)) return '';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

const SOURCE_LABELS: Readonly<Record<string, string>> = {
  youtube: 'YouTube',
  ytmusic: 'YT Music',
  soundcloud: 'SoundCloud',
};

/** Short label for a track's download site; `null` when it has no source. */
export function sourceLabel(site: string | undefined | null): string | null {
  if (!site) return null;
  return SOURCE_LABELS[site.toLowerCase()] ?? 'Link';
}

export type DownloadStateKind = 'saved' | 'downloading' | 'failed';

/**
 * Short reason for a save that failed on an age check. Exported so callers can
 * match the label (e.g. to show the age hint) instead of copying the wording.
 */
export const AGE_RESTRICTED_REASON = 'Age-restricted';

/** [pattern, short reason], first match wins (age before the generic "sign in"). */
const FAILURE_REASONS: readonly (readonly [RegExp, string])[] = [
  [/cancelled/i, 'Cancelled'],
  [/wi-?fi/i, 'Waiting for Wi-Fi'],
  [/confirm your age|age[- ]restricted|inappropriate/i, AGE_RESTRICTED_REASON],
  [/private video/i, 'Private video'],
  [/country|region|geo/i, 'Blocked in region'],
  [/not a bot/i, 'Blocked by YouTube'],
  [/video unavailable|removed|terminated|does not exist|no longer available/i, 'Video unavailable'],
  [/busy|rate limit|too many requests/i, 'Server busy'],
  [/sign in/i, 'Sign in needed'],
  [/could not (download|fetch) the audio/i, 'Download error'],
  [/could not reach|set up a download server/i, 'Server offline'],
  [/no direct audio|no download link/i, 'No audio found'],
];

/** Short reason for a stored save failure message ("Failed" when unknown). */
export function failureReason(error: string | undefined): string {
  if (!error) return 'Failed';
  return FAILURE_REASONS.find(([re]) => re.test(error))?.[1] ?? 'Failed';
}

/**
 * Row tag for an offline status; `null` when nothing is on the device. A
 * failed tag is labelled with the short reason from `error` when known.
 */
export function downloadState(
  status: OfflineStatus | undefined,
  error?: string,
): { kind: DownloadStateKind; label: string } | null {
  switch (status) {
    case 'saved':
      return { kind: 'saved', label: 'On device' };
    case 'queued':
    case 'saving':
      return { kind: 'downloading', label: 'Downloading' };
    case 'failed':
      return { kind: 'failed', label: failureReason(error) };
    default:
      return null;
  }
}

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
