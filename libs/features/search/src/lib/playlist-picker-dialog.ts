import {
  ChangeDetectionStrategy,
  Component,
  effect,
  inject,
  input,
  model,
  signal,
  untracked,
} from '@angular/core';
import type { Track } from '@open-record/models';
import { PlaylistsStore } from '@open-record/state';
import { OrButton, OrEmptyState, OrModal, OrToast } from '@open-record/ui';

/** "Add to playlist" modal for one search record: pick a playlist to append it to. */
@Component({
  selector: 'or-playlist-picker-dialog',
  imports: [OrButton, OrEmptyState, OrModal],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <or-modal heading="Add to playlist" [(open)]="open">
      @if (track(); as t) {
        <p class="for">{{ t.title }}</p>
      }
      @if (playlists.playlists().length) {
        <ul class="list" aria-label="Playlists">
          @for (p of playlists.playlists(); track p.id) {
            <li>
              <or-button
                block
                [disabled]="busy()"
                [ariaLabel]="'Add to ' + p.name"
                (click)="add(p.id)"
              >
                {{ p.name }}
              </or-button>
            </li>
          }
        </ul>
      } @else {
        <or-empty-state>
          No playlists yet. Create one from the Library tab.
        </or-empty-state>
      }
      <p class="err" aria-live="polite">{{ error() }}</p>
      <div orModalActions>
        <or-button block (click)="open.set(false)">Cancel</or-button>
      </div>
    </or-modal>
  `,
  styles: `
    .for {
      margin: 0;
      font-size: 13px;
      color: var(--color-muted);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .list {
      display: grid;
      gap: var(--spacing-sm);
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .err {
      min-block-size: 1.4em;
      margin: 0;
      font-size: 12px;
      color: var(--color-primary);
    }
  `,
})
export class PlaylistPickerDialog {
  protected readonly playlists = inject(PlaylistsStore);
  private readonly toast = inject(OrToast);

  readonly open = model(false);
  readonly track = input<Track | null>(null);

  protected readonly busy = signal(false);
  protected readonly error = signal('');

  constructor() {
    effect(() => {
      if (!this.open()) return;
      untracked(() => this.error.set(''));
    });
  }

  protected async add(playlistId: string): Promise<void> {
    const t = this.track();
    if (!t || this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    try {
      const name = this.playlists.playlist(playlistId)?.name ?? 'playlist';
      await this.playlists.addTracks(playlistId, [t]);
      this.open.set(false);
      this.toast.show(`Added to ${name}`);
    } catch {
      this.error.set('Could not add to that playlist. Try again.');
    } finally {
      this.busy.set(false);
    }
  }
}
