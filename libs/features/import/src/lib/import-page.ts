import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { AuthStore, ImportStore, SyncStore, type ImportSummary, type ParsedImport } from '@open-record/state';
import { OrButton, OrSectionHead, OrToast } from '@open-record/ui';
import { JobProgress } from './job-progress';
import { ReviewList } from './review-list';
import { SHARED_STYLES } from './shared';
import { SourceStep, type LoadedFile } from './source-step';

type Step = 'source' | 'job';

/**
 * Spotify import wizard: choose a source (Exportify CSV, pasted or picked;
 * data-download JSON), select playlists, then follow matching progress and
 * review. Parsed data stays in memory until handed to `ImportStore.start`.
 */
@Component({
  selector: 'or-import-page',
  imports: [JobProgress, NgTemplateOutlet, OrButton, OrSectionHead, ReviewList, SourceStep],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @switch (step()) {
      @case ('source') {
        <or-section-head heading="Choose a source" />
        <p class="lede">
          Bring your Spotify playlists and Liked Songs. Open Record finds each song on your download server;
          nothing is downloaded until you save it.
        </p>
        <ng-container *ngTemplateOutlet="syncHint" />
        <or-source-step
          [files]="files()"
          (fileAdded)="addFile($event)"
          (clear)="files.set([])"
          (filesReady)="importFiles()"
          [busy]="starting()"
          [(likeToo)]="likeToo"
        />
        @if (error(); as e) {
          <p class="note" role="alert">{{ e }}</p>
        }
        @if (store.hasJob()) {
          <div class="actions">
            <or-button (click)="override.set('job')">Back to import progress</or-button>
          </div>
        }
      }
      @case ('job') {
        <or-section-head heading="Matching" />
        <or-job-progress />
        <ng-container *ngTemplateOutlet="syncHint" />
        <div class="actions">
          <or-button (click)="override.set('source')">Import more</or-button>
        </div>
        <or-review-list (deleted)="override.set('source')" />
      }
    }

    <ng-template #syncHint>
      @if (sync.available) {
        <p class="note sync-hint">
          @if (auth.signedIn()) {
            Results sync to your other devices.
          } @else {
            Sign in under Settings, Account to sync results to your other devices.
          }
        </p>
      }
    </ng-template>
  `,
  styles: [
    SHARED_STYLES,
    `or-section-head:first-child { margin-top: var(--spacing-xs); }
    .sync-hint { margin: 0 0 var(--spacing-md); }`,
  ],
})
export class ImportPage {
  protected readonly store = inject(ImportStore);
  protected readonly auth = inject(AuthStore);
  protected readonly sync = inject(SyncStore);
  private readonly toast = inject(OrToast);

  /** User-chosen step; otherwise the job view when a job exists. */
  protected readonly override = signal<Step | null>(null);
  protected readonly step = computed<Step>(() => {
    const o = this.override();
    if (o === 'job' && !this.store.hasJob()) return 'source';
    return o ?? (this.store.hasJob() ? 'job' : 'source');
  });

  protected readonly files = signal<readonly LoadedFile[]>([]);
  protected readonly starting = signal(false);
  protected readonly error = signal<string | null>(null);
  /** "Also add these songs to Liked Songs" (bookmarks every imported playlist track). */
  protected readonly likeToo = signal(false);

  protected readonly merged = computed<ParsedImport>(() => ({
    playlists: this.files().flatMap((f) => f.parsed.playlists),
    liked: this.files().flatMap((f) => f.parsed.liked),
  }));
  constructor() {
    void this.store.ready();
  }

  protected addFile(file: LoadedFile): void {
    this.files.update((list) => [...list, file]);
  }

  protected async importFiles(): Promise<void> {
    const merged = this.merged();
    await this.begin(async () => merged);
    if (this.step() === 'job') this.files.set([]);
  }

  private async begin(load: () => Promise<ParsedImport | null>): Promise<void> {
    this.starting.set(true);
    this.error.set(null);
    try {
      const parsed = await load();
      if (!parsed) return;
      const summary = await this.store.start(parsed, { likeAll: this.likeToo() });
      this.toast.show(describe(summary), 3200);
      this.override.set('job');
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Could not start the import. Try again.');
    } finally {
      this.starting.set(false);
    }
  }
}

function describe(s: ImportSummary): string {
  const parts = [`${s.playlists} playlist${s.playlists === 1 ? '' : 's'}`];
  if (s.liked) parts.push(`${s.liked} liked`);
  return `Imported ${parts.join(' and ')}. Matching ${s.tracks - s.alreadyMatched} new tracks.`;
}
