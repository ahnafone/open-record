import { DestroyRef, inject, signal, type Signal } from '@angular/core';

/** Styles shared by the wizard's parts (kept small: each component pays for it). */
export const SHARED_STYLES = `
  :host { display: block; }
  .lede, .note { margin: var(--spacing-xs) 0 var(--spacing-md); font-size: 13px; line-height: 1.45; color: var(--color-muted); }
  .note { margin: var(--spacing-xs) 0 0; font-size: 12px; }
  .status { margin: var(--spacing-xs) 0 0; min-block-size: 18px; font-size: 12px; line-height: 1.5; color: var(--color-muted); font-variant-numeric: tabular-nums; }
  .status.bad { color: var(--color-primary); }
  .actions { display: flex; flex-wrap: wrap; gap: var(--spacing-sm); margin-top: var(--spacing-md); }
  .banner { margin: var(--spacing-md) 0 0; padding: var(--spacing-md); font-size: 13px; line-height: 1.45;
    background: color-mix(in srgb, var(--color-primary) 10%, transparent);
    border: 1px solid color-mix(in srgb, var(--color-primary) 42%, transparent); border-radius: var(--rounded-md); }
  .banner ul { margin: var(--spacing-xs) 0 0; padding-inline-start: 18px; color: var(--color-muted); }
`;

/** A clock that ticks every second (for rate-limit countdowns). */
export function secondsClock(): Signal<number> {
  const now = signal(Date.now());
  const id = setInterval(() => now.set(Date.now()), 1000);
  inject(DestroyRef).onDestroy(() => clearInterval(id));
  return now;
}

/** "Waiting 42s for Spotify…" style countdown text, or '' when not waiting. */
export function waitText(retryAt: number | null, now: number, who: string): string {
  if (!retryAt || retryAt <= now) return '';
  const sec = Math.ceil((retryAt - now) / 1000);
  return `${who} asked us to slow down. Retrying in ${sec}s…`;
}

/** Save `text` as a file via a temporary link (web and Capacitor web views). */
export function downloadText(name: string, text: string, type = 'text/csv'): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
