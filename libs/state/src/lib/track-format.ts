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

/** Row tag for an offline status; `null` when nothing is on the device. */
export function downloadState(
  status: OfflineStatus | undefined,
): { kind: DownloadStateKind; label: string } | null {
  switch (status) {
    case 'saved':
      return { kind: 'saved', label: 'On device' };
    case 'queued':
    case 'saving':
      return { kind: 'downloading', label: 'Downloading' };
    case 'failed':
      return { kind: 'failed', label: 'Failed' };
    default:
      return null;
  }
}
