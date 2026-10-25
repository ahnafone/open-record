import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  model,
  signal,
  untracked,
} from '@angular/core';
import { LibraryStore, PlaylistsStore } from '@open-record/state';
import {
  OrButton,
  OrEmptyState,
  OrModal,
  OrSleeve,
  OrTag,
  OrToast,
} from '@open-record/ui';
import { injectTrackArt } from './track-art';

/** "Add records" modal: pick library records that are not in the playlist yet. */
@Component({
  selector: 'or-add-records-dialog',
  imports: [OrButton, OrEmptyState, OrModal, OrSleeve, OrTag],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <or-modal heading="Add records" [(open)]="open">
      @if (candidates().length) {
        <fieldset class="list">
          <legend class="sr-only">Records to add</legend>
          @for (track of candidates(); track track.id) {
            <label class="row">
              <input
                type="checkbox"
                [checked]="selected().has(track.id)"
                (change)="toggle(track.id)"
              />
              <or-sleeve size="thumb" [src]="art(track)" />
              <span class="text">
                <span class="title">{{ track.title }}</span>
                <span class="artist">{{ track.artist }}</span>
                @if (library.isImported(track)) {
                  <span class="tags"><or-tag ivory>Imported</or-tag></span>
                }
              </span>
            </label>
          }
        </fieldset>
      } @else {
        <or-empty-state>Every record in your library is already here.</or-empty-state>
      }
      <p class="err" aria-live="polite">{{ error() }}</p>
      <div orModalActions>
        @if (candidates().length) {
          <or-button
            variant="primary"
            block
            [disabled]="saving() || !selected().size"
            (click)="submit()"
          >
            {{ submitLabel() }}
          </or-button>
        }
        <or-button block (click)="open.set(false)">
          {{ candidates().length ? 'Cancel' : 'Done' }}
        </or-button>
      </div>
    </or-modal>
  `,
  styles: `
    :host {
      display: contents;
    }
    .sr-only {
      position: absolute;
      inline-size: 1px;
      block-size: 1px;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
    }
    .list {
      display: grid;
      grid-auto-rows: max-content;
      margin: 0;
      padding: 0;
      border: 0;
      min-inline-size: 0;
      max-block-size: 42vh;
      overflow: auto;
    }
    .row {
      display: grid;
      grid-template-columns: auto auto minmax(0, 1fr);
      align-items: center;
      gap: var(--spacing-md);
      min-block-size: 72px;
      padding: 6px var(--spacing-xs);
      border-top: 1px solid color-mix(in srgb, var(--color-border) 30%, transparent);
      cursor: pointer;
    }
    .row:first-of-type {
      border-top: 0;
    }
    input {
      inline-size: 20px;
      block-size: 20px;
      margin: 0;
      accent-color: var(--color-primary);
      cursor: pointer;
    }
    input:focus-visible {
      outline: 2px solid var(--color-primary);
      outline-offset: 2px;
    }
    .text {
      display: grid;
      min-inline-size: 0;
    }
    .tags {
      display: flex;
      margin-top: var(--spacing-xs);
    }
    .title,
    .artist {
      min-inline-size: 0;
    }
    .title {
      font-size: 14px;
      font-weight: 600;
      line-height: 1.25;
      overflow-wrap: anywhere;
    }
    .artist {
      font-size: 13px;
      color: var(--color-muted);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .err {
      margin: 0;
      min-block-size: 1.4em;
      color: var(--color-primary);
      font-size: 12px;
      line-height: 1.4;
    }
  `,
})
export class AddRecordsDialog {
  protected readonly library = inject(LibraryStore);
  protected readonly art = injectTrackArt();
  private readonly playlists = inject(PlaylistsStore);
  private readonly toast = inject(OrToast);

  readonly open = model(false);
  readonly playlistId = input.required<string>();

  protected readonly selected = signal<ReadonlySet<string>>(new Set());
  protected readonly saving = signal(false);
  protected readonly error = signal('');

  /** Library records not yet in the playlist, in library order. */
  protected readonly candidates = computed(() => {
    const have = new Set(this.playlists.playlist(this.playlistId())?.trackIds);
    return this.library.tracks().filter((t) => !have.has(t.id));
  });

  protected readonly submitLabel = computed(() => {
    const n = this.selected().size;
    if (!n) return 'Add records';
    return n === 1 ? 'Add 1 record' : `Add ${n} records`;
  });

  constructor() {
    effect(() => {
      if (!this.open()) return;
      untracked(() => {
        this.selected.set(new Set());
        this.error.set('');
      });
    });
  }

  protected toggle(id: string): void {
    this.selected.update((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    this.error.set('');
  }

  protected async submit(): Promise<void> {
    if (this.saving() || !this.selected().size) return;
    const chosen = this.selected();
    const ids = this.candidates()
      .filter((t) => chosen.has(t.id))
      .map((t) => t.id);
    this.saving.set(true);
    try {
      await this.playlists.addTracks(this.playlistId(), ids);
      this.open.set(false);
      this.toast.show(
        ids.length === 1 ? 'Added 1 record' : `Added ${ids.length} records`,
      );
    } catch {
      this.error.set('Could not add those records. Try again.');
    } finally {
      this.saving.set(false);
    }
  }
}
