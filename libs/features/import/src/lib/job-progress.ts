import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { ImportStore } from '@open-record/state';
import { OrButton, OrDialog, OrProgressLine, OrSpinner } from '@open-record/ui';
import { SHARED_STYLES, secondsClock, waitText } from './shared';

/** Step 3: matching progress with pause / resume / cancel. */
@Component({
  selector: 'or-job-progress',
  imports: [OrButton, OrProgressLine, OrSpinner],
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
    <div class="actions">
      @switch (store.status()) {
        @case ('running') {
          <or-button (click)="store.pause()">Pause</or-button>
        }
        @case ('paused') {
          <or-button variant="primary" (click)="store.resume()">{{ store.error() ? 'Retry' : 'Resume' }}</or-button>
        }
      }
      @if (store.status() === 'running' || store.status() === 'paused') {
        <or-button variant="danger" (click)="cancel()">Cancel matching</or-button>
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
    `,
  ],
})
export class JobProgress {
  protected readonly store = inject(ImportStore);
  private readonly dialog = inject(OrDialog);
  private readonly now = secondsClock();

  protected readonly p = this.store.progress;
  protected readonly wait = computed(() => waitText(this.store.retryAt(), this.now(), 'The server'));
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

  protected async cancel(): Promise<void> {
    const ok = await this.dialog.confirm({
      title: 'Cancel matching?',
      message: 'Tracks not yet matched move to Unmatched. Playlists and matches so far stay.',
      confirmLabel: 'Cancel matching',
      danger: true,
    });
    if (ok) await this.store.cancel();
  }
}
