import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { RouterLink } from '@angular/router';
import { AuthStore, ImportStore, SyncStore, type ImportSummary, type ParsedImport } from '@open-record/state';
import { OrButton, OrSectionHead, OrToast } from '@open-record/ui';
import { JobProgress } from './job-progress';
import { JobSongs } from './job-songs';
import { ReviewList } from './review-list';
import { SHARED_STYLES } from './shared';
import { SourceStep, type LoadedFile } from './source-step';

type Step = 'source' | 'job';

/**
 * Import wizard: choose a source (audio files on this device; Exportify CSV,
 * pasted or picked; data-download JSON; or a YouTube / YT Music playlist or song
 * link), then follow the one import job: progress, review and the songs added.
 * Parsed Spotify data stays in memory until handed to `ImportStore.start`.
 */
@Component({
  selector: 'or-import-page',
  imports: [JobProgress, JobSongs, NgTemplateOutlet, OrButton, OrSectionHead, ReviewList, RouterLink, SourceStep],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @switch (step()) {
      @case ('source') {
        <or-section-head heading="Choose a source" />
        <p class="lede">
          Add audio files from this device, bring your Spotify playlists and Liked Songs, or a public YouTube or YT Music playlist or song. Open
          Record finds each song on your download server; nothing is downloaded until you save it.
        </p>
        <ng-container *ngTemplateOutlet="syncHint" />
        <or-source-step
          [files]="files()"
          (fileAdded)="addFile($event)"
          (clear)="files.set([])"
          (filesReady)="importFiles()"
          (youtubeImported)="override.set('job')"
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
        <p class="links"><a class="text-link" routerLink="/import/sessions">Import history</a></p>
      }
      @case ('job') {
        <or-section-head heading="Import progress" />
        <or-job-progress />
        <ng-container *ngTemplateOutlet="syncHint" />
        <div class="actions">
          <or-button (click)="override.set('source')">Import more</or-button>
        </div>
        <or-review-list (deleted)="override.set('source')">
          <or-job-songs />
        </or-review-list>
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
    .sync-hint { margin: 0 0 var(--spacing-md); }
    .links { margin: var(--spacing-md) 0 0; }
    .text-link { display: inline-flex; align-items: center; min-block-size: var(--spacing-touch); font-size: 13px; color: var(--color-text);
      text-decoration: underline; text-underline-offset: 3px; border-radius: var(--rounded-md); }
    .text-link:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 2px; }`,
  ],
})
export class ImportPage {
  protected readonly store = inject(ImportStore);
  protected readonly auth = inject(AuthStore);
  protected readonly sync = inject(SyncStore);
  private readonly toast = inject(OrToast);

  /**
   * User-chosen step; otherwise the job view only while matching needs the
   * user (a finished job stays one tap away, "Back to import progress").
   */
  protected readonly override = signal<Step | null>(null);
  protected readonly step = computed<Step>(() => {
    const o = this.override();
    if (o === 'job' && !this.store.hasJob()) return 'source';
    return o ?? (this.store.needsAttention() ? 'job' : 'source');
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

  /** First file name (or playlist name), plus how many more. */
  private sessionLabel(): string | undefined {
    const names = this.files().map((f) => f.name);
    const first = names[0] ?? this.merged().playlists[0]?.name;
    if (!first) return undefined;
    return names.length > 1 ? `${first} +${names.length - 1} more` : first;
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
      const summary = await this.store.start(parsed, { likeAll: this.likeToo(), label: this.sessionLabel() });
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
