import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { Router } from '@angular/router';
import type { Track } from '@open-record/models';
import { LibraryStore, PlayerStore, PlaylistsStore } from '@open-record/state';
import {
  OrButton,
  OrDialog,
  OrEmptyState,
  OrIcon,
  OrIconButton,
  OrModal,
  OrSectionHead,
  OrSleeve,
  OrSpinner,
  OrTag,
  OrToast,
} from '@open-record/ui';
import { AddRecordsDialog } from './add-records-dialog';
import { RenamePlaylistDialog } from './rename-playlist-dialog';
import { injectTrackArt } from './track-art';

/**
 * Playlist screen: header (name, visibility, count), Play / Shuffle, record
 * management (add, reorder, remove), rename, visibility and delete. The top
 * bar already carries the name as the page's h1, so the header uses an h2.
 */
@Component({
  selector: 'or-playlist-page',
  imports: [
    AddRecordsDialog,
    OrButton,
    OrEmptyState,
    OrIcon,
    OrIconButton,
    OrModal,
    OrSectionHead,
    OrSleeve,
    OrSpinner,
    OrTag,
    RenamePlaylistDialog,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (playlist(); as pl) {
      <header class="head">
        <span class="eyebrow">Playlist · listening copy</span>
        <h2 class="name">{{ pl.name }}</h2>
        <div class="meta">
          <or-tag [icon]="pl.visibility === 'public' ? 'globe' : 'lock'">
            {{ pl.visibility === 'public' ? 'Public' : 'Private' }}
          </or-tag>
          <or-tag>{{ countLabel() }}</or-tag>
        </div>
      </header>

      <div class="actions">
        <or-button variant="primary" (click)="play(false)">
          <or-icon name="play" [size]="20" />Play
        </or-button>
        <or-button (click)="play(true)">
          <or-icon name="shuffle" [size]="20" />Shuffle
        </or-button>
        <or-button data-add-records (click)="addOpen.set(true)">
          <or-icon name="plus" [size]="20" />Add records
        </or-button>
        <or-button (click)="renameOpen.set(true)">
          <or-icon name="settings" [size]="20" />Rename
        </or-button>
        <or-button (click)="toggleVisibility()">
          <or-icon
            [name]="pl.visibility === 'public' ? 'lock' : 'globe'"
            [size]="20"
          />{{ pl.visibility === 'public' ? 'Make private' : 'Make public' }}
        </or-button>
        <or-button variant="danger" (click)="remove()">
          <or-icon name="trash" [size]="20" />Delete
        </or-button>
      </div>

      <or-section-head heading="Records" [level]="3" />
      @if (tracks().length) {
        <ol class="tracks">
          @for (track of tracks(); track track.id; let i = $index) {
            <li class="track" [class.is-current]="player.isCurrent(track.id)">
              <button
                type="button"
                class="track-main"
                [attr.aria-label]="playLabel(track)"
                [attr.aria-current]="player.isCurrent(track.id) ? 'true' : null"
                (click)="playFrom(i)"
              >
                <or-sleeve
                  [src]="art(track)"
                  [label]="track.title"
                  [playing]="player.isCurrent(track.id) && player.isPlaying()"
                />
                <span class="text">
                  <span class="title">{{ track.title }}</span>
                  <span class="artist">{{ track.artist }}</span>
                  @let imported = library.isImported(track);
                  @if (imported || track.year || track.genre) {
                    <span class="tags">
                      @if (imported) {
                        <or-tag ivory>Imported</or-tag>
                      }
                      @if (track.year) {
                        <or-tag>{{ track.year }}</or-tag>
                      }
                      @if (track.genre) {
                        <or-tag>{{ track.genre }}</or-tag>
                      }
                    </span>
                  }
                </span>
              </button>
              <or-icon-button
                icon="more"
                [attr.data-options]="track.id"
                [label]="'Options for ' + track.title"
                (click)="optionsFor.set(track)"
              />
            </li>
          }
        </ol>
      } @else {
        <or-empty-state>This crate is empty. Add records to fill it.</or-empty-state>
      }

      <p class="note">
        {{
          pl.visibility === 'public'
            ? 'Marked public. Sharing comes in a later version; for now it stays on this device.'
            : 'Private. Kept on this device only.'
        }}
      </p>

      <or-modal
        [open]="!!optionsFor()"
        [heading]="optionsFor()?.title ?? 'Record'"
        (dismissed)="optionsFor.set(null)"
      >
        <div orModalActions>
          <or-button block [disabled]="optionIndex() <= 0" (click)="move(-1)">
            Move up
          </or-button>
          <or-button
            block
            [disabled]="optionIndex() < 0 || optionIndex() >= tracks().length - 1"
            (click)="move(1)"
          >
            Move down
          </or-button>
          <or-button block variant="danger" (click)="removeTrack()">
            Remove from playlist
          </or-button>
          <or-button block (click)="optionsFor.set(null)">Close</or-button>
        </div>
      </or-modal>

      <or-rename-playlist-dialog
        [(open)]="renameOpen"
        [playlistId]="pl.id"
        [currentName]="pl.name"
      />
      <or-add-records-dialog [(open)]="addOpen" [playlistId]="pl.id" />
    } @else if (loading()) {
      <p class="status"><or-spinner label="Loading playlist" /></p>
    } @else {
      <or-empty-state>
        <p class="missing">That playlist no longer exists.</p>
        <or-button size="sm" (click)="goToLibrary()">Go to Library</or-button>
      </or-empty-state>
    }
  `,
  styles: `
    :host {
      display: block;
    }
    .head {
      display: grid;
      gap: 6px;
      margin: 2px 0 10px;
    }
    .eyebrow {
      font-size: var(--type-eyebrow-font-size);
      letter-spacing: var(--type-eyebrow-letter-spacing);
      text-transform: uppercase;
      color: var(--color-muted);
    }
    .name {
      margin: 0;
      font-family: var(--type-display-font-family);
      font-size: var(--type-display-font-size);
      font-weight: var(--type-display-font-weight);
      line-height: var(--type-display-line-height);
      overflow-wrap: anywhere;
    }
    .meta,
    .actions,
    .tags {
      display: flex;
      flex-wrap: wrap;
    }
    .meta {
      gap: 6px;
    }
    .actions {
      gap: var(--spacing-sm);
      margin: 2px 0 6px;
    }
    .tracks {
      display: grid;
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .track {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: center;
      gap: var(--spacing-xs);
      padding: 2px 0;
      border-top: 1px solid
        color-mix(in srgb, var(--color-border) 32%, transparent);
    }
    .track:first-child {
      border-top: 0;
    }
    .track-main {
      appearance: none;
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      align-items: center;
      gap: 10px;
      min-block-size: 60px;
      min-inline-size: 0;
      padding: var(--spacing-xs);
      background: transparent;
      border: 0;
      border-radius: var(--rounded-md);
      color: inherit;
      font: inherit;
      text-align: left;
      cursor: pointer;
      transition: background var(--duration-fast) var(--ease-standard);
    }
    .track-main:hover {
      background: color-mix(in srgb, var(--color-text) 5%, transparent);
    }
    .track-main:focus-visible {
      outline: 2px solid var(--color-primary);
      outline-offset: 2px;
    }
    .text {
      display: grid;
      min-inline-size: 0;
    }
    .title {
      font-size: 14px;
      font-weight: 600;
      line-height: 1.3;
      overflow-wrap: anywhere;
    }
    .is-current .title {
      color: var(--color-primary);
    }
    .artist {
      font-size: 13px;
      color: var(--color-muted);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .tags {
      gap: var(--spacing-xs);
      margin-top: 3px;
    }
    .note {
      margin: 14px 0 0;
      font-size: 12px;
      color: var(--color-muted);
    }
    .status {
      display: flex;
      justify-content: center;
      margin: var(--spacing-xl) 0;
      color: var(--color-muted);
    }
    .missing {
      margin: 0 0 var(--spacing-md);
    }
    @media (prefers-reduced-motion: reduce) {
      .track-main {
        transition-duration: 1ms;
      }
    }
  `,
})
export class PlaylistPage {
  private readonly playlists = inject(PlaylistsStore);
  protected readonly library = inject(LibraryStore);
  protected readonly art = injectTrackArt();
  protected readonly player = inject(PlayerStore);
  private readonly dialog = inject(OrDialog);
  private readonly toast = inject(OrToast);
  private readonly router = inject(Router);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  /** Playlist id from the `playlist/:id` route (component input binding). */
  readonly id = input.required<string>();

  protected readonly playlist = computed(() => this.playlists.playlist(this.id()));
  /** Resolved records, in playlist order. */
  protected readonly tracks = computed(() => this.playlists.tracksOf(this.id()));
  protected readonly loading = computed(
    () =>
      this.playlists.status() === 'loading' ||
      this.library.status() === 'loading',
  );
  protected readonly countLabel = computed(() => {
    const n = this.tracks().length;
    return `${n} record${n === 1 ? '' : 's'}`;
  });

  protected readonly renameOpen = signal(false);
  protected readonly addOpen = signal(false);
  /** Record whose options modal is open. */
  protected readonly optionsFor = signal<Track | null>(null);
  protected readonly optionIndex = computed(() => {
    const t = this.optionsFor();
    return t ? this.tracks().findIndex((x) => x.id === t.id) : -1;
  });

  protected playLabel(track: Track): string {
    const now = this.player.isCurrent(track.id) ? ', now playing' : '';
    return `Play ${track.title} by ${track.artist}${now}`;
  }

  protected async play(shuffle: boolean): Promise<void> {
    if (!this.tracks().length) {
      this.toast.show('This playlist has no records yet');
      return;
    }
    try {
      await this.player.playPlaylist(this.id(), { shuffle });
    } catch {
      this.toast.show('Could not play this playlist');
    }
  }

  protected async playFrom(index: number): Promise<void> {
    try {
      await this.player.playPlaylist(this.id(), {
        startIndex: index,
        shuffle: false,
      });
    } catch {
      this.toast.show('Could not play that record');
    }
  }

  protected async toggleVisibility(): Promise<void> {
    const pl = this.playlist();
    if (!pl) return;
    const next = pl.visibility === 'public' ? 'private' : 'public';
    try {
      await this.playlists.setVisibility(pl.id, next);
      this.toast.show(`Playlist is now ${next}`);
    } catch {
      this.toast.show('Could not change visibility. Try again.');
    }
  }

  /** Swap the optioned record with its neighbour (`dir` -1 up, +1 down). */
  protected async move(dir: -1 | 1): Promise<void> {
    const pl = this.playlist();
    const track = this.optionsFor();
    const tracks = this.tracks();
    const i = this.optionIndex();
    const neighbour = tracks[i + dir];
    this.optionsFor.set(null);
    if (!pl || !track || i < 0 || !neighbour) return;
    // moveTrack works on raw ids (which may include unresolved ones).
    const from = pl.trackIds.indexOf(track.id);
    const to = pl.trackIds.indexOf(neighbour.id);
    try {
      await this.playlists.moveTrack(pl.id, from, to);
      this.toast.show('Record moved');
    } catch {
      this.toast.show('Could not move that record. Try again.');
    }
  }

  protected async removeTrack(): Promise<void> {
    const track = this.optionsFor();
    const i = this.optionIndex();
    this.optionsFor.set(null);
    if (!track) return;
    try {
      await this.playlists.removeTrack(this.id(), track.id);
      this.toast.show(`Removed “${track.title}”`);
      // The row (and its options button) is gone; move focus somewhere sane.
      afterNextRender(
        () => {
          const root = this.host.nativeElement;
          const options = root.querySelectorAll<HTMLElement>('[data-options] button');
          const target =
            options[Math.min(i, options.length - 1)] ??
            root.querySelector<HTMLElement>('[data-add-records] button');
          target?.focus();
        },
        { injector: this.injector },
      );
    } catch {
      this.toast.show('Could not remove that record. Try again.');
    }
  }

  protected async remove(): Promise<void> {
    const pl = this.playlist();
    if (!pl) return;
    const ok = await this.dialog.confirm({
      title: 'Delete playlist?',
      message: `“${pl.name}” and its record order will be removed from this device. This cannot be undone.`,
      confirmLabel: 'Delete playlist',
      danger: true,
    });
    if (!ok) return;
    try {
      await this.playlists.delete(pl.id);
      await this.router.navigateByUrl('/library', { replaceUrl: true });
      this.toast.show('Playlist deleted');
    } catch {
      this.toast.show('Could not delete the playlist. Try again.');
    }
  }

  protected goToLibrary(): void {
    void this.router.navigateByUrl('/library', { replaceUrl: true });
  }
}
