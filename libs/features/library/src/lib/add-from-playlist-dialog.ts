import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  model,
  output,
  signal,
} from '@angular/core';
import type { Playlist } from '@open-record/models';
import {
  LibraryStore,
  PlaylistsStore,
  SettingsStore,
} from '@open-record/state';
import { OrButton, OrEmptyState, OrModal, OrToast } from '@open-record/ui';

/** One-line summary of an "add playlist to library" run. */
export function addFromPlaylistSummary(result: {
  added: number;
  alreadySaved: number;
  unavailable: number;
}): string {
  const records = (n: number) => `${n} record${n === 1 ? '' : 's'}`;
  const parts = [`Added ${records(result.added)}`];
  if (result.alreadySaved) parts.push(`${result.alreadySaved} already saved`);
  if (result.unavailable) parts.push(`${result.unavailable} unavailable`);
  return parts.join(', ');
}

/**
 * "Add songs from playlist" modal: pick a playlist and bookmark all of its
 * tracks in one write, keeping the playlist's order (first track on top).
 */
@Component({
  selector: 'or-add-from-playlist-dialog',
  imports: [OrButton, OrEmptyState, OrModal],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <or-modal heading="Add songs from playlist" [(open)]="open" (dismissed)="reset()">
      @if (playlists.playlists().length) {
        <fieldset class="picker" [disabled]="saving()">
          <legend>Playlist</legend>
          @for (pl of playlists.playlists(); track pl.id) {
            <label class="option" [class.is-selected]="selectedId() === pl.id">
              <input
                type="radio"
                name="add-from-playlist"
                [value]="pl.id"
                [checked]="selectedId() === pl.id"
                (change)="selectedId.set(pl.id)"
              />
              <span class="option-info">
                <span class="option-name">{{ pl.name }}</span>
                <span class="option-meta">{{ meta(pl) }}</span>
              </span>
            </label>
          }
        </fieldset>
        <p class="note" role="status">
          @if (settings.autoDownloadLibrary()) {
            Auto-download is on: these will start downloading.
          }
        </p>
      } @else {
        <or-empty-state>No playlists yet. Create one first.</or-empty-state>
      }
      <div orModalActions>
        <or-button
          variant="primary"
          block
          [disabled]="!selected() || saving()"
          (click)="submit()"
        >
          {{ saving() ? 'Adding…' : 'Add to Library' }}
        </or-button>
        <or-button block [disabled]="saving()" (click)="close()">Cancel</or-button>
      </div>
    </or-modal>
  `,
  styles: `
    :host {
      display: contents;
    }
    .picker {
      display: grid;
      gap: var(--spacing-xs);
      margin: 0;
      padding: 0;
      border: 0;
      min-inline-size: 0;
    }
    legend {
      margin-bottom: var(--spacing-xs);
      padding: 0;
      font-size: 11px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--color-muted);
    }
    .option {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      gap: var(--spacing-sm);
      align-items: center;
      min-block-size: 64px;
      padding: var(--spacing-sm) var(--spacing-md);
      background: var(--color-background);
      border: 1px solid color-mix(in srgb, var(--color-border) 50%, transparent);
      border-radius: var(--rounded-md);
      cursor: pointer;
      transition:
        background var(--duration-fast) var(--ease-standard),
        border-color var(--duration-fast) var(--ease-standard);
    }
    .option:hover {
      background: var(--color-surface-raised);
    }
    .option.is-selected {
      border-color: var(--color-primary);
    }
    input[type='radio'] {
      inline-size: 20px;
      block-size: 20px;
      margin: 0;
      accent-color: var(--color-primary);
    }
    input[type='radio']:focus-visible {
      outline: 2px solid var(--color-primary);
      outline-offset: 2px;
    }
    .option-info {
      display: grid;
      min-inline-size: 0;
    }
    .option-name {
      font-family: var(--font-display);
      font-size: 18px;
      line-height: 1.25;
      overflow-wrap: anywhere;
    }
    .option-meta {
      font-size: var(--type-meta-font-size);
      color: var(--color-muted);
    }
    /* Reserved so the actions do not jump when the note appears. */
    .note {
      margin: 0;
      min-block-size: 18px;
      font-size: 12px;
      line-height: 1.5;
      color: var(--color-muted);
    }
    @media (prefers-reduced-motion: reduce) {
      .option {
        transition-duration: 1ms;
      }
    }
  `,
})
export class AddFromPlaylistDialog {
  protected readonly playlists = inject(PlaylistsStore);
  protected readonly settings = inject(SettingsStore);
  private readonly library = inject(LibraryStore);
  private readonly toast = inject(OrToast);

  readonly open = model(false);
  /** Emitted after tracks were added (at least one new bookmark). */
  readonly added = output<void>();

  protected readonly selectedId = signal<string | null>(null);
  protected readonly saving = signal(false);
  protected readonly selected = computed(() => {
    const id = this.selectedId();
    return id ? this.playlists.playlist(id) : undefined;
  });

  protected meta(pl: Playlist): string {
    const n = pl.trackIds.length;
    return `${n} record${n === 1 ? '' : 's'}`;
  }

  protected async submit(): Promise<void> {
    const pl = this.selected();
    if (!pl || this.saving()) return;
    this.saving.set(true);
    try {
      const result = await this.library.addTracksToLibrary(pl.trackIds);
      this.close();
      this.toast.show(addFromPlaylistSummary(result), 3200);
      if (result.added) this.added.emit();
    } catch {
      // The dialog stays open with the selection kept, so retrying is one tap.
      this.toast.show(`Could not add songs from “${pl.name}”. Try again.`);
    } finally {
      this.saving.set(false);
    }
  }

  protected close(): void {
    this.open.set(false);
    this.reset();
  }

  protected reset(): void {
    this.selectedId.set(null);
  }
}
