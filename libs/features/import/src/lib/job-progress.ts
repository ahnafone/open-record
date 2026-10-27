import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { ImportStore } from '@open-record/state';
import { OrButton, OrDialog, OrProgressLine, OrSpinner } from '@open-record/ui';
import { SHARED_STYLES, secondsClock, waitText } from './shared';

/**
 * The one import job's progress for every source: a source label, counts
 * from item states, one progress line and one Pause / Resume / Stop. For
 * YouTube songs the matching phase is the song-detail lookup.
 */
@Component({
  selector: 'or-job-progress',
  imports: [OrButton, OrProgressLine, OrSpinner],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <p class="source">{{ sourceText() }}</p>
    <dl class="counts">
      <div><dt>Matched</dt><dd>{{ p().matched }}</dd></div>
      <div><dt>To review</dt><dd>{{ p().review }}</dd></div>
      <div><dt>Not found</dt><dd>{{ p().unmatched }}</dd></div>
      <div><dt>Pending</dt><dd>{{ p().pending }}</dd></div>
    </dl>
    <or-progress-line class="bar" [value]="p().total - p().pending" [max]="p().total || 1" />
    <p class="status" [class.bad]="!!store.error()" role="status" aria-live="polite">
      @if (store.status() === 'running' && !store.error() && !wait()) {
        <or-spinner [size]="14" />
      }
      {{ statusText() }}
    </p>

    <div class="actions">
      @if (store.status() === 'running') {
        <or-button (click)="store.pause()">Pause</or-button>
      }
      @if (store.status() === 'paused') {
        <or-button variant="primary" (click)="store.resume()">{{ store.error() ? 'Retry' : 'Resume' }}</or-button>
      }
      @if (store.status() === 'running' || store.status() === 'paused') {
        <or-button variant="danger" (click)="stop()">Stop</or-button>
      }
    </div>
  `,
  styles: [
    SHARED_STYLES,
    `
      .source { margin: 0 0 var(--spacing-sm); font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--color-muted);
        overflow-wrap: anywhere; }
      .counts { display: grid; grid-template-columns: repeat(4, 1fr); gap: var(--spacing-sm); margin: 0 0 var(--spacing-md); }
      .counts div { display: grid; gap: 2px; padding: var(--spacing-sm); background: var(--color-surface);
        border: 1px solid color-mix(in srgb, var(--color-border) 45%, transparent); border-radius: var(--rounded-md); }
      dt { font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--color-muted); }
      dd { margin: 0; font-family: var(--font-display); font-size: 20px; font-variant-numeric: tabular-nums; }
      .status { display: flex; align-items: center; gap: 6px; }
    `,
  ],
})
export class JobProgress {
  protected readonly store = inject(ImportStore);
  private readonly dialog = inject(OrDialog);
  private readonly now = secondsClock();

  protected readonly p = this.store.progress;
  protected readonly wait = computed(() => waitText(this.store.retryAt(), this.now(), 'The server'));

  /** "YouTube · Road trip" / "Spotify · liked.csv" (latest import into the job). */
  protected readonly sourceText = computed(() => {
    const source = this.store.source();
    if (!source) return 'Import';
    const kind = source.kind === 'youtube' ? 'YouTube' : 'Spotify';
    return source.label ? `${kind} · ${source.label}` : kind;
  });

  protected readonly statusText = computed(() => {
    const error = this.store.error();
    if (error) return error;
    if (this.wait()) return this.wait();
    const { total, pending } = this.p();
    const verb = this.store.source()?.kind === 'youtube' ? 'Finding song details' : 'Matching';
    switch (this.store.status()) {
      case 'running':
        return `${verb} ${Math.min(total, total - pending + 1)} of ${total}…`;
      case 'paused':
        return `Paused · ${total - pending} of ${total} checked.`;
      case 'done':
        return 'Matching finished.';
      default:
        return '';
    }
  });

  protected async stop(): Promise<void> {
    const ok = await this.dialog.confirm({
      title: 'Stop this import?',
      message: 'Tracks not yet matched move to Not found; YouTube songs keep their original details. Playlists and matches so far stay.',
      confirmLabel: 'Stop',
      danger: true,
    });
    if (ok) await this.store.cancel();
  }
}
