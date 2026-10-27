import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { ImportStore } from '@open-record/state';
import { OrButton, OrDialog, OrIcon, OrProgressLine, OrSpinner } from '@open-record/ui';
import { SHARED_STYLES, secondsClock, waitText } from './shared';

/**
 * The one import job's progress: matching counts, then (for YouTube songs) the
 * song-detail lookup. Pause, Resume and Stop act on both queues.
 */
@Component({
  selector: 'or-job-progress',
  imports: [OrButton, OrIcon, OrProgressLine, OrSpinner],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <dl class="counts">
      <div><dt>Matched</dt><dd>{{ p().matched }}</dd></div>
      <div><dt>To review</dt><dd>{{ p().review }}</dd></div>
      <div><dt>Unmatched</dt><dd>{{ p().unmatched }}</dd></div>
      <div><dt>Pending</dt><dd>{{ p().pending }}</dd></div>
    </dl>
    <or-progress-line class="bar" [value]="p().total - p().pending" [max]="p().total || 1" />
    <p class="status" [class.bad]="!!store.error()" role="status" aria-live="polite">
      @if (store.status() === 'running' && !store.error() && !wait()) {
        <or-spinner [size]="14" />
      }
      {{ statusText() }}
    </p>

    @if (store.enrichStatus() !== 'idle') {
      <div class="enrich">
        <p class="enrich-head">Finding song details</p>
        <p class="status" [class.bad]="!!store.enrichError()" role="status" aria-live="polite">
          @if (store.enrichStatus() === 'running' && !store.enrichError() && !enrichWait()) {
            <or-spinner [size]="14" />
          }
          {{ enrichText() }}
        </p>
        <or-progress-line [value]="e().total - e().pending" [max]="e().total || 1" />
        @if (store.enrichStatus() === 'done') {
          <div class="actions">
            <or-button size="sm" (click)="store.dismissEnrichment()"><or-icon name="check" [size]="18" />Done</or-button>
          </div>
        }
      </div>
    }

    <div class="actions">
      @if (running()) {
        <or-button (click)="store.pause()">Pause</or-button>
      }
      @if (paused()) {
        <or-button variant="primary" (click)="store.resume()">{{ store.error() || store.enrichError() ? 'Retry' : 'Resume' }}</or-button>
      }
      @if (running() || paused()) {
        <or-button variant="danger" (click)="stop()">Stop</or-button>
      }
    </div>
  `,
  styles: [
    SHARED_STYLES,
    `
      .counts { display: grid; grid-template-columns: repeat(4, 1fr); gap: var(--spacing-sm); margin: 0 0 var(--spacing-md); }
      .counts div { display: grid; gap: 2px; padding: var(--spacing-sm); background: var(--color-surface);
        border: 1px solid color-mix(in srgb, var(--color-border) 45%, transparent); border-radius: var(--rounded-md); }
      dt { font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--color-muted); }
      dd { margin: 0; font-family: var(--font-display); font-size: 20px; font-variant-numeric: tabular-nums; }
      .status { display: flex; align-items: center; gap: 6px; }
      .enrich { margin-top: var(--spacing-md); padding: var(--spacing-md); background: var(--color-surface);
        border: 1px solid color-mix(in srgb, var(--color-border) 45%, transparent); border-radius: var(--rounded-md); }
      .enrich-head { margin: 0; font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--color-muted); }
      .enrich .status { margin-bottom: var(--spacing-xs); }
    `,
  ],
})
export class JobProgress {
  protected readonly store = inject(ImportStore);
  private readonly dialog = inject(OrDialog);
  private readonly now = secondsClock();

  protected readonly p = this.store.progress;
  protected readonly e = this.store.enrichProgress;
  protected readonly wait = computed(() => waitText(this.store.retryAt(), this.now(), 'The server'));
  protected readonly enrichWait = computed(() => waitText(this.store.enrichRetryAt(), this.now(), 'The server'));

  /** Either queue is working. */
  protected readonly running = computed(() => this.store.status() === 'running' || this.store.enrichStatus() === 'running');
  /** Nothing is working but a queue was paused. */
  protected readonly paused = computed(
    () => !this.running() && (this.store.status() === 'paused' || this.store.enrichStatus() === 'paused'),
  );

  protected readonly statusText = computed(() => {
    const error = this.store.error();
    if (error) return error;
    if (this.wait()) return this.wait();
    const { total, pending } = this.p();
    switch (this.store.status()) {
      case 'running':
        return `Matching ${Math.min(total, total - pending + 1)} of ${total}…`;
      case 'paused':
        return 'Paused.';
      case 'done':
        return 'Matching finished.';
      default:
        return '';
    }
  });

  protected readonly enrichText = computed(() => {
    const error = this.store.enrichError();
    if (error) return error;
    if (this.enrichWait()) return this.enrichWait();
    const { total, pending, enriched } = this.e();
    const base = `${total - pending} of ${total} checked · ${enriched} updated`;
    switch (this.store.enrichStatus()) {
      case 'paused':
        return `Paused · ${base}`;
      case 'done':
        return `Done · ${base}. Songs without a confident match keep their YouTube titles.`;
      default:
        return base;
    }
  });

  protected async stop(): Promise<void> {
    const ok = await this.dialog.confirm({
      title: 'Stop this import?',
      message: 'Tracks not yet matched move to Unmatched, and song details stop updating. Playlists and matches so far stay.',
      confirmLabel: 'Stop',
      danger: true,
    });
    if (ok) await this.store.cancel();
  }
}
