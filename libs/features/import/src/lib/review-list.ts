import { ChangeDetectionStrategy, Component, DestroyRef, inject, output, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import type { Track } from '@open-record/models';
import { ImportStore, LibraryStore, PreviewPlayerService, type ImportItem } from '@open-record/state';
import {
  OrButton,
  OrDialog,
  OrEmptyState,
  OrIcon,
  OrIconButton,
  OrSectionHead,
  OrSpinner,
  OrToast,
} from '@open-record/ui';
import { LinkPaste } from './link-paste';
import { MatchCandidates, MetaCandidates } from './match-candidates';
import { SHARED_STYLES, downloadText } from './shared';

/**
 * Step 4: review uncertain matches, export unmatched, delete import data.
 * Spotify rows pick a recording; YouTube rows keep their own link (previewed
 * here) and pick song details, keep the original, or take another link.
 */
@Component({
  selector: 'or-review-list',
  imports: [LinkPaste, MatchCandidates, MetaCandidates, NgTemplateOutlet, OrButton, OrEmptyState, OrIcon, OrIconButton, OrSectionHead, OrSpinner],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <or-section-head heading="To review" [level]="3" />
    @if (store.reviewItems().length) {
      <p class="lede">Pick the right recording or song details, or skip to leave it unmatched.</p>
      <ul class="rows">
        @for (item of store.reviewItems(); track item.key) {
          @let searching = store.searching().has(item.key);
          @let locked = busy() === item.key || searching;
          <li class="row">
            @if (item.origin === 'youtube') {
              <ng-container *ngTemplateOutlet="youtubeHead; context: { $implicit: item }" />
              @if (item.linkError) {
                <ng-container *ngTemplateOutlet="linkFailed; context: { $implicit: item }" />
              } @else {
                <or-meta-candidates
                  [candidates]="item.metaCandidates ?? []"
                  [disabled]="locked"
                  [pendingId]="busy() === item.key ? pendingMeta() : null"
                  (use)="acceptMeta(item, $event.id)"
                />
                <div class="item-actions">
                  <or-button size="sm" [disabled]="locked" (click)="keepOriginal(item)">Keep original</or-button>
                  <or-button size="sm" [disabled]="locked" (click)="skip(item)">Skip</or-button>
                  <or-button size="sm" [disabled]="locked" (click)="research(item)">
                    @if (searching) {
                      <or-spinner [size]="14" label="Searching" />
                    }
                    Search again
                  </or-button>
                </div>
                <or-link-paste [itemKey]="item.key" [disabled]="busy() === item.key" label="Paste another link" />
              }
            } @else {
              <span class="title">{{ item.title }}</span>
              <span class="meta">{{ item.artist }}{{ item.album ? ' · ' + item.album : '' }}{{ time(item.durationMs) }}</span>
              <or-match-candidates
                [candidates]="item.candidates ?? []"
                [disabled]="locked"
                (use)="accept(item, $event.id)"
              />
              <div class="item-actions">
                <or-button size="sm" [disabled]="locked" (click)="skip(item)">Skip</or-button>
                <or-button size="sm" [disabled]="locked" (click)="research(item)">
                  @if (searching) {
                    <or-spinner [size]="14" label="Searching" />
                  }
                  Search again
                </or-button>
              </div>
              <or-link-paste [itemKey]="item.key" [disabled]="busy() === item.key" />
            }
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
        Spotify tracks stay as placeholders: export them as CSV to find them elsewhere or import again later. YouTube songs keep their original details.
      </p>
      <div class="actions">
        <or-button (click)="download()">Download CSV</or-button>
        <or-button (click)="copy()">Copy CSV</or-button>
      </div>
      <ul class="rows">
        @for (item of store.unmatchedItems(); track item.key) {
          <li class="row">
            @if (item.origin === 'youtube') {
              <ng-container *ngTemplateOutlet="youtubeHead; context: { $implicit: item }" />
              @if (item.linkError) {
                <ng-container *ngTemplateOutlet="linkFailed; context: { $implicit: item }" />
              } @else {
                @if (item.metaCandidates?.length) {
                  <or-button size="sm" [disabled]="busy() === item.key || store.searching().has(item.key)" (click)="reopen(item)">Review again</or-button>
                }
                <or-link-paste [itemKey]="item.key" [disabled]="busy() === item.key" label="Paste another link" />
              }
            } @else {
              <span class="title">{{ item.title }}</span>
              <span class="meta">{{ item.artist }}{{ item.album ? ' · ' + item.album : '' }}</span>
              @if (item.candidates?.length) {
                <or-button size="sm" [disabled]="busy() === item.key || store.searching().has(item.key)" (click)="reopen(item)">Review again</or-button>
              }
              <or-link-paste [itemKey]="item.key" [disabled]="busy() === item.key" />
            }
          </li>
        }
      </ul>
    } @else {
      <or-empty-state>No unmatched tracks.</or-empty-state>
    }

    <!-- The job's finished songs (projected by the import page). -->
    <ng-content />

    <or-section-head heading="Import data" [level]="3" />
    <p class="lede">
      Deletes the match list and progress. Unmatched placeholders are removed from playlists and your library;
      matched tracks stay.
    </p>
    <or-button variant="danger" block (click)="deleteData()">Delete import data</or-button>
    <p class="status bad" role="status">{{ error() }}</p>

    <!-- A YouTube song: its current details and a preview of its own link (the fixed audio). -->
    <ng-template #youtubeHead let-item>
      @let track = linkTrack(item);
      <div class="yt-head">
        <span class="text">
          <span class="title" [class.is-current]="!!track && preview.playingId() === track.id">{{ item.title }}</span>
          <span class="meta">{{ item.artist }}{{ item.album ? ' · ' + item.album : '' }}{{ time(item.durationMs) }}</span>
          <span class="site">YouTube link</span>
        </span>
        @if (track && !item.linkError) {
          @let playing = preview.playingId() === track.id;
          @let loading = preview.loadingId() === track.id;
          <or-icon-button
            [icon]="loading ? null : playing ? 'pause' : 'play'"
            [label]="'Play preview of ' + item.title"
            [pressed]="playing"
            (click)="togglePreview(track)"
          >
            @if (loading) {
              <or-spinner [size]="18" label="Loading preview" />
            }
          </or-icon-button>
        }
      </div>
    </ng-template>

    <!-- The song's link cannot be used: pasting another one is the fix. -->
    <ng-template #linkFailed let-item>
      <p class="status bad link-error"><or-icon name="alert" [size]="14" />{{ item.linkError }}</p>
      <or-link-paste [itemKey]="item.key" [disabled]="busy() === item.key" label="Paste another link" expanded />
      @if (item.state === 'review') {
        <div class="item-actions">
          <or-button size="sm" [disabled]="busy() === item.key" (click)="skip(item)">Skip</or-button>
        </div>
      }
    </ng-template>
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
      .title.is-current { color: var(--color-primary); }
      .yt-head { display: flex; align-items: center; gap: var(--spacing-sm); justify-self: stretch; }
      .yt-head .text { display: grid; gap: 2px; flex: 1; min-inline-size: 0; }
      .site { font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--color-muted); }
      or-meta-candidates { justify-self: stretch; }
      .link-error { display: flex; align-items: center; gap: 6px; }
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

  private readonly library = inject(LibraryStore);

  protected readonly busy = signal<string | null>(null);
  /** Metadata suggestion being applied (spinner on its button). */
  protected readonly pendingMeta = signal<string | null>(null);
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

  /** The YouTube song's own track (its link is the audio), if still in the library. */
  protected linkTrack(item: ImportItem): Track | undefined {
    return this.library.track(this.store.resolveId(item.key));
  }

  protected togglePreview(track: Track): void {
    void this.preview.toggle(track);
  }

  protected async acceptMeta(item: ImportItem, candidateId: string): Promise<void> {
    void this.preview.stop();
    this.pendingMeta.set(candidateId);
    try {
      await this.run(item.key, () => this.store.acceptMetadata(item.key, candidateId));
    } finally {
      this.pendingMeta.set(null);
    }
  }

  protected async keepOriginal(item: ImportItem): Promise<void> {
    void this.preview.stop();
    await this.run(item.key, () => this.store.keepOriginal(item.key));
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
