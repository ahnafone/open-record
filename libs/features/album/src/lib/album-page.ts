import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { Router } from '@angular/router';
import type { Track } from '@open-record/models';
import {
  ArtistsStore,
  LibraryStore,
  PlayerStore,
  PlaylistsStore,
  SourceFixService,
  TrackArtService,
  creditFromNames,
  formatDuration,
} from '@open-record/state';
import {
  OrArtistLinks,
  OrButton,
  OrEmptyState,
  OrIcon,
  OrModal,
  OrSectionHead,
  OrSleeve,
  OrSpinner,
  OrTag,
  OrToast,
} from '@open-record/ui';
import { AlbumTrackRow } from './album-track-row';

/**
 * Album screen: cover, title, the artists (each links to their own screen),
 * year and track count, Play / Shuffle, then the tracklist. Only the user's
 * own tracks of the album are listed, the same ones the store gives.
 */
@Component({
  selector: 'or-album-page',
  imports: [
    AlbumTrackRow,
    OrArtistLinks,
    OrButton,
    OrEmptyState,
    OrIcon,
    OrModal,
    OrSectionHead,
    OrSleeve,
    OrSpinner,
    OrTag,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (album(); as al) {
      <header class="head">
        <div class="cover">
          <or-sleeve
            size="large"
            [src]="art(al.coverTrack)"
            [label]="al.title"
          />
        </div>
        <div class="intro">
          <span class="eyebrow">Album</span>
          <h2 class="name">{{ al.title }}</h2>
          <p class="by">
            <or-artist-links [credit]="credit()" />
          </p>
          <div class="meta">
            @if (al.year) {
              <or-tag>{{ al.year }}</or-tag>
            }
            <or-tag>{{ countLabel() }}</or-tag>
          </div>
          <div class="actions">
            <or-button variant="primary" (click)="play(false)">
              <or-icon name="play" [size]="20" />Play
            </or-button>
            <or-button (click)="play(true)">
              <or-icon name="shuffle" [size]="20" />Shuffle
            </or-button>
          </div>
        </div>
      </header>

      @if (al.tracks.length) {
        <or-section-head heading="Tracklist" [level]="3" />
        <div class="list">
          @for (t of al.tracks; track t.id; let i = $index) {
            <or-album-track-row
              [track]="t"
              [duration]="formatDuration(t.durationSec)"
              [current]="player.isCurrent(t.id)"
              [playing]="player.isCurrent(t.id) && player.isPlaying()"
              [saved]="library.isSaved(t.id)"
              [imported]="library.isImported(t)"
              (playTrack)="playFrom(i)"
              (save)="toggleSaved(t, library.isSaved(t.id))"
              (options)="openOptions(t, $event)"
            />
          }
        </div>
      }

      <or-modal
        [open]="!!optionsFor()"
        [heading]="optionsFor()?.title ?? 'Record'"
        (dismissed)="optionsFor.set(null)"
      >
        <div orModalActions>
          <or-button block (click)="playNext()">Play next</or-button>
          @if (optionsFor()?.source?.url) {
            <or-button block (click)="fixSource()">Fix source</or-button>
          }
          <or-button block (click)="optionsFor.set(null)">Close</or-button>
        </div>
      </or-modal>
    } @else if (loading()) {
      <p class="status"><or-spinner label="Loading album" /></p>
    } @else {
      <or-empty-state>
        <p class="missing">That album isn’t in your library.</p>
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
      gap: var(--spacing-sm);
      margin: 2px 0 var(--spacing-sm);
    }
    .cover {
      inline-size: 200px;
      block-size: 200px;
      margin-inline: auto;
    }
    .intro {
      display: grid;
      gap: 6px;
      min-inline-size: 0;
      text-align: center;
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
    .by {
      margin: 0;
      font-size: 15px;
      color: var(--color-muted);
      overflow-wrap: anywhere;
    }
    .meta,
    .actions {
      display: flex;
      flex-wrap: wrap;
      justify-content: center;
    }
    .meta {
      gap: 6px;
    }
    .actions {
      gap: var(--spacing-sm);
      margin: 2px 0 6px;
    }
    .list {
      display: grid;
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
    @media (min-width: 900px) {
      .head {
        grid-template-columns: 200px minmax(0, 1fr);
        align-items: end;
        gap: var(--spacing-md);
      }
      .cover {
        margin-inline: 0;
      }
      .intro {
        text-align: left;
      }
      .meta,
      .actions {
        justify-content: flex-start;
      }
    }
  `,
})
export class AlbumPage {
  private readonly artists = inject(ArtistsStore);
  private readonly playlists = inject(PlaylistsStore);
  protected readonly library = inject(LibraryStore);
  protected readonly player = inject(PlayerStore);
  private readonly trackArt = inject(TrackArtService);
  private readonly sourceFix = inject(SourceFixService);
  private readonly toast = inject(OrToast);
  private readonly router = inject(Router);

  /** Album key from the `album/:key` route (the router decodes it). */
  readonly key = input.required<string>();

  protected readonly album = computed(() => this.artists.album(this.key()));
  protected readonly loading = computed(
    () =>
      this.library.status() === 'loading' ||
      this.playlists.status() === 'loading',
  );

  /** Credited artists, already split by the store; each links to its screen. */
  protected readonly credit = computed(() =>
    creditFromNames(this.album()?.artistNames ?? []),
  );

  protected readonly countLabel = computed(() => {
    const n = this.album()?.tracks.length ?? 0;
    return `${n} song${n === 1 ? '' : 's'}`;
  });

  /** Record whose options modal is open. */
  protected readonly optionsFor = signal<Track | null>(null);
  /** The ⋯ button that opened the options modal (for focus return). */
  private readonly optionsOrigin = signal<HTMLElement | null>(null);

  protected readonly art = (track: Track | null | undefined) =>
    this.trackArt.art(track);
  protected readonly formatDuration = formatDuration;

  /** Play or shuffle the album's tracks, in tracklist order. */
  protected async play(shuffle: boolean): Promise<void> {
    const tracks = this.album()?.tracks ?? [];
    if (!tracks.length) {
      this.toast.show('No records to play');
      return;
    }
    const start = shuffle ? Math.floor(Math.random() * tracks.length) : 0;
    try {
      await this.player.playTracks(tracks, start, {
        shuffle,
        queue: 'playlist',
      });
    } catch {
      this.toast.show('Could not play this album');
    }
  }

  protected async playFrom(index: number): Promise<void> {
    try {
      await this.player.playTracks(this.album()?.tracks ?? [], index, {
        shuffle: false,
        queue: 'playlist',
      });
    } catch {
      this.toast.show('Could not play that record');
    }
  }

  protected async toggleSaved(track: Track, saved: boolean): Promise<void> {
    try {
      await this.library.setSaved(track.id, !saved);
      this.toast.show(
        saved
          ? `Removed “${track.title}” from your library`
          : `Saved “${track.title}” to your library`,
      );
    } catch {
      this.toast.show(
        `Could not ${saved ? 'remove' : 'save'} “${track.title}”. Try again.`,
      );
    }
  }

  /** Open the row's options modal, remembering its button for focus. */
  protected openOptions(track: Track, event: MouseEvent): void {
    const host = event.currentTarget as HTMLElement;
    this.optionsOrigin.set(host.querySelector<HTMLElement>('button') ?? host);
    this.optionsFor.set(track);
  }

  /** Close the options modal and open the shell's Fix source dialog. */
  protected fixSource(): void {
    const track = this.optionsFor();
    const origin = this.optionsOrigin();
    this.optionsFor.set(null);
    if (!track) return;
    this.sourceFix.open(track, origin ?? undefined);
  }

  /** Queue the optioned record right after the current one. */
  protected async playNext(): Promise<void> {
    const track = this.optionsFor();
    this.optionsFor.set(null);
    if (!track) return;
    try {
      await this.player.playNext([track]);
      this.toast.show(`“${track.title}” plays next`);
    } catch {
      this.toast.show('Could not queue that record. Try again.');
    }
  }

  protected goToLibrary(): void {
    void this.router.navigateByUrl('/library', { replaceUrl: true });
  }
}
