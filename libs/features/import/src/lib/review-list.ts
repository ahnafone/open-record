import { ChangeDetectionStrategy, Component, DestroyRef, inject, output, signal } from '@angular/core';
import { ImportStore, PreviewPlayerService, type ImportItem } from '@open-record/state';
import {
  OrButton,
  OrDialog,
  OrEmptyState,
  OrSectionHead,
  OrSpinner,
  OrToast,
} from '@open-record/ui';
import { LinkPaste } from './link-paste';
import { MatchCandidates } from './match-candidates';
import { SHARED_STYLES, downloadText } from './shared';

/** Step 4: review uncertain matches, export unmatched, delete import data. */
@Component({
  selector: 'or-review-list',
  imports: [LinkPaste, MatchCandidates, OrButton, OrEmptyState, OrSectionHead, OrSpinner],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <or-section-head heading="To review" [level]="3" />
    @if (store.reviewItems().length) {
      <p class="lede">Pick the right recording, or skip to leave it unmatched.</p>
      <ul class="rows">
        @for (item of store.reviewItems(); track item.key) {
          <li class="row">
            <span class="title">{{ item.title }}</span>
            <span class="meta">{{ item.artist }}{{ item.album ? ' · ' + item.album : '' }}{{ time(item.durationMs) }}</span>
            @let searching = store.searching().has(item.key);
            <or-match-candidates
              [candidates]="item.candidates ?? []"
              [disabled]="busy() === item.key || searching"
              (use)="accept(item, $event.id)"
            />
            <div class="item-actions">
              <or-button size="sm" [disabled]="busy() === item.key || searching" (click)="skip(item)">Skip</or-button>
              <or-button size="sm" [disabled]="busy() === item.key || searching" (click)="research(item)">
                @if (searching) {
                  <or-spinner [size]="14" label="Searching" />
                }
                Search again
              </or-button>
            </div>
            <or-link-paste [itemKey]="item.key" [disabled]="busy() === item.key" />
          </li>
        }
      </ul>
      <p class="status bad preview-error" role="status">{{ preview.error() }}</p>
    } @else {
      <or-empty-state>Nothing to review.</or-empty-state>
    }

    <or-section-head heading="Unmatched" [level]="3" />
    @if (store.unmatchedItems().length) {
      <p class="lede">
        These stay as placeholders. Export them as CSV to find them elsewhere or import again later.
      </p>
      <div class="actions">
        <or-button (click)="download()">Download CSV</or-button>
        <or-button (click)="copy()">Copy CSV</or-button>
      </div>
      <ul class="rows">
        @for (item of store.unmatchedItems(); track item.key) {
          <li class="row">
            <span class="title">{{ item.title }}</span>
            <span class="meta">{{ item.artist }}{{ item.album ? ' · ' + item.album : '' }}</span>
            @if (item.candidates?.length) {
              <or-button size="sm" [disabled]="busy() === item.key || store.searching().has(item.key)" (click)="reopen(item)">Review again</or-button>
            }
            <or-link-paste [itemKey]="item.key" [disabled]="busy() === item.key" />
          </li>
        }
      </ul>
    } @else {
      <or-empty-state>No unmatched tracks.</or-empty-state>
    }

    <or-section-head heading="Import data" [level]="3" />
    <p class="lede">
      Deletes the match list and progress. Unmatched placeholders are removed from playlists and your library;
      matched tracks stay.
    </p>
    <or-button variant="danger" block (click)="deleteData()">Delete import data</or-button>
    <p class="status bad" role="status">{{ error() }}</p>
  `,
  styles: [
    SHARED_STYLES,
    `
      .rows { margin: 0; padding: 0; list-style: none; }
      .row { display: grid; gap: 2px; justify-items: start; min-block-size: 60px; padding: var(--spacing-md) 0;
        border-top: 1px solid color-mix(in srgb, var(--color-border) 32%, transparent); }
      .row:first-child { border-top: 0; }
      or-match-candidates { justify-self: stretch; }
      .title { font-size: 14px; font-weight: 600; overflow-wrap: anywhere; }
      .meta { font-size: 12px; color: var(--color-muted); overflow-wrap: anywhere; }
      .actions { margin: 0 0 var(--spacing-sm); }
      .item-actions { display: flex; flex-wrap: wrap; gap: var(--spacing-sm); }
    `,
  ],
})
export class ReviewList {
  protected readonly store = inject(ImportStore);
  protected readonly preview = inject(PreviewPlayerService);
  private readonly dialog = inject(OrDialog);
  private readonly toast = inject(OrToast);

  /** Emitted after the import data was deleted. */
  readonly deleted = output<void>();

  protected readonly busy = signal<string | null>(null);
  protected readonly error = signal('');

  constructor() {
    inject(DestroyRef).onDestroy(() => void this.preview.stop());
  }

  protected time(ms: number | undefined): string {
    if (!ms) return '';
    const s = Math.round(ms / 1000);
    return ` · ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  protected async accept(item: ImportItem, trackId: string): Promise<void> {
    await this.run(item.key, () => this.store.acceptCandidate(item.key, trackId));
  }

  protected async skip(item: ImportItem): Promise<void> {
    void this.preview.stop();
    await this.run(item.key, () => this.store.skip(item.key));
  }

  protected async research(item: ImportItem): Promise<void> {
    void this.preview.stop();
    await this.run(item.key, () => this.store.research(item.key));
  }

  protected async reopen(item: ImportItem): Promise<void> {
    void this.preview.stop();
    await this.run(item.key, () => this.store.reopen(item.key));
  }

  protected download(): void {
    downloadText('open-record-unmatched.csv', this.store.unmatchedCsv());
  }

  protected async copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.store.unmatchedCsv());
      this.toast.show('CSV copied');
    } catch {
      this.toast.show('Could not copy. Use Download CSV.');
    }
  }

  protected async deleteData(): Promise<void> {
    const ok = await this.dialog.confirm({
      title: 'Delete import data?',
      message: 'Matching stops and unmatched placeholders are removed. Matched tracks stay in your library.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      await this.store.deleteImportData();
      this.toast.show('Import data deleted');
      this.deleted.emit();
    } catch {
      this.error.set('Could not delete the import data. Try again.');
    }
  }

  private async run(key: string, task: () => Promise<void>): Promise<void> {
    this.busy.set(key);
    this.error.set('');
    try {
      await task();
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Something went wrong. Try again.');
    } finally {
      this.busy.set(null);
    }
  }
}
