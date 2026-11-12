import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import type { Track } from '@open-record/models';
import {
  ArtistImageStore,
  ArtistsStore,
  LibraryStore,
  PlayerStore,
  PlaylistsStore,
  SourceFixService,
  TrackArtService,
  filterWords,
  formatDuration,
  trackMatches,
  SessionRefusedError,
} from '@open-record/state';
import {
  OrButton,
  OrDisc,
  OrEmptyState,
  OrFilterField,
  OrIcon,
  OrLoadMore,
  OrModal,
  OrSectionHead,
  OrSleeve,
  OrSpinner,
  OrSwipeRow,
  OrTag,
  OrToast,
  lazyWindow,
} from '@open-record/ui';
import { ArtistTrackRow } from './artist-track-row';

/** Rows rendered per page; the filter appears once a list outgrows one page. */
const PAGE_SIZE = 40;

const NO_TRACKS: readonly Track[] = [];

/**
 * Artist screen: portrait (the artist's image, else the first album's sleeve,
 * else a disc), name, Play / Shuffle over every record they have, then the
 * sections that have content: Songs in Library, Albums, In your playlists.
 * Play and Shuffle cover the library songs first, then the playlist-only ones.
 */
@Component({
  selector: 'or-artist-page',
  imports: [
    ArtistTrackRow,
    OrButton,
    OrDisc,
    OrEmptyState,
    OrFilterField,
    OrIcon,
    OrLoadMore,
    OrModal,
    OrSectionHead,
    OrSwipeRow,
    OrSleeve,
    OrSpinner,
    OrTag,
    RouterLink,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (artist(); as a) {
      <header class="head">
        <div class="portrait">
          @if (image(); as src) {
            <img [src]="src" [alt]="a.name" decoding="async" />
          } @else if (cover(); as t) {
            <or-sleeve size="large" [src]="art(t)" [label]="a.name" />
          } @else {
            <or-disc [showLabel]="false" />
          }
        </div>
        <div class="intro">
          <span class="eyebrow">Artist</span>
          <h2 class="name">{{ a.name }}</h2>
          <div class="meta">
            <or-tag>{{ countLabel() }}</or-tag>
          </div>
          <div class="actions">
            <or-button variant="primary" (click)="playAll(false)">
              <or-icon name="play" [size]="20" />Play
            </or-button>
            <or-button (click)="playAll(true)">
              <or-icon name="shuffle" [size]="20" />Shuffle
            </or-button>
          </div>
        </div>
      </header>

      @if (libraryTracks().length) {
        <or-section-head heading="Songs in Library" [level]="3" />
        @if (showFilter()) {
          <or-filter-field
            class="filter"
            label="Filter these songs"
            placeholder="Filter by title, artist or album"
            describedBy="or-artist-filter-status"
            [(value)]="query"
            (settledValue)="listQuery.set($event)"
          />
          <p id="or-artist-filter-status" class="filter-status" role="status">
            @if (filtering()) {
              {{ libraryView().length }} of {{ libraryTracks().length }} match
            }
          </p>
        }
        @if (libraryWindow.items().length) {
          <div class="list">
            @for (t of libraryWindow.items(); track t.id; let i = $index) {
              <or-artist-track-row
                [track]="t"
                [duration]="formatDuration(t.durationSec)"
                [current]="player.isCurrent(t.id)"
                [playing]="player.isCurrent(t.id) && player.isPlaying()"
                [saved]="library.isSaved(t.id)"
                [imported]="library.isImported(t)"
                orSwipeRow
                (swiped)="addToStack(t)"
                (playTrack)="playLibraryFrom(i)"
                (save)="toggleSaved(t, library.isSaved(t.id))"
                (options)="openOptions(t, $event)"
              />
            }
          </div>
          @if (libraryWindow.hasMore()) {
            <div
              class="sentinel"
              orLoadMore
              [loadMoreKey]="libraryWindow.items().length"
              (loadMore)="libraryWindow.grow()"
            ></div>
          }
        } @else {
          <or-empty-state
            >No songs match “{{ listQuery().trim() }}”.</or-empty-state
          >
        }
      }

      @if (albums().length) {
        <or-section-head heading="Albums" [level]="3" />
        <div class="albums">
          @for (al of albums(); track al.key) {
            <a
              class="album"
              [routerLink]="['/album', al.key]"
              [attr.aria-label]="al.title + ', ' + albumDetail(al)"
            >
              <or-sleeve
                class="sleeve"
                size="thumb"
                [src]="art(al.coverTrack)"
                [label]="al.title"
              />
              <span class="album-title">{{ al.title }}</span>
              <span class="album-detail">{{ albumDetail(al) }}</span>
            </a>
          }
        </div>
      }

      @if (playlistOnly().length) {
        <or-section-head heading="In your playlists" [level]="3" />
        <div class="list">
          @for (t of playlistWindow.items(); track t.id; let i = $index) {
            <or-artist-track-row
              [track]="t"
              [duration]="formatDuration(t.durationSec)"
              [current]="player.isCurrent(t.id)"
              [playing]="player.isCurrent(t.id) && player.isPlaying()"
              [saved]="library.isSaved(t.id)"
              [imported]="library.isImported(t)"
              orSwipeRow
              (swiped)="addToStack(t)"
              (playTrack)="playPlaylistFrom(i)"
              (save)="toggleSaved(t, library.isSaved(t.id))"
              (options)="openOptions(t, $event)"
            />
          }
        </div>
        @if (playlistWindow.hasMore()) {
          <div
            class="sentinel"
            orLoadMore
            [loadMoreKey]="playlistWindow.items().length"
            (loadMore)="playlistWindow.grow()"
          ></div>
        }
      }

      <or-modal
        [open]="!!optionsFor()"
        [heading]="optionsFor()?.title ?? 'Record'"
        (dismissed)="optionsFor.set(null)"
      >
        <div orModalActions>
          <or-button block (click)="playNext()">Play next</or-button>
          <or-button block (click)="addToStackFromOptions()">Add to Stack</or-button>
          @if (optionsFor()?.source?.url) {
            <or-button block (click)="fixSource()">Fix source</or-button>
          }
          <or-button block (click)="optionsFor.set(null)">Close</or-button>
        </div>
      </or-modal>
    } @else if (loading()) {
      <p class="status"><or-spinner label="Loading artist" /></p>
    } @else {
      <or-empty-state>
        <p class="missing">That artist isn’t in your library.</p>
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
    .portrait {
      inline-size: 168px;
      block-size: 168px;
      margin-inline: auto;
    }
    .portrait img {
      display: block;
      inline-size: 100%;
      block-size: 100%;
      object-fit: cover;
      border-radius: var(--rounded-md);
      background: var(--color-surface);
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
    .filter {
      margin-block-start: var(--spacing-xs);
    }
    .filter-status {
      margin: var(--spacing-xxs) 0 var(--spacing-xs);
      min-block-size: 18px;
      font-size: 12px;
      line-height: 1.5;
      color: var(--color-muted);
      font-variant-numeric: tabular-nums;
    }
    .list {
      display: grid;
    }
    .sentinel {
      block-size: 1px;
    }
    .albums {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(132px, 1fr));
      gap: var(--spacing-sm);
      margin-block-start: var(--spacing-xs);
    }
    .album {
      display: grid;
      align-content: start;
      gap: var(--spacing-xxs);
      min-inline-size: 0;
      padding: var(--spacing-xs) var(--spacing-xs) var(--spacing-sm);
      border-radius: var(--rounded-md);
      color: inherit;
      text-decoration: none;
    }
    .album:focus-visible {
      outline: 2px solid var(--color-primary);
      outline-offset: 2px;
    }
    .album .sleeve {
      --s: 96px;
      margin-block-end: var(--spacing-sm);
    }
    .album-title {
      font-family: var(--type-display-font-family);
      font-size: 15px;
      font-weight: 600;
      line-height: 1.3;
      overflow-wrap: anywhere;
    }
    .album-detail {
      font-size: 12px;
      color: var(--color-muted);
    }
    @media (hover: hover) {
      .album:hover {
        background: color-mix(in srgb, var(--color-text) 5%, transparent);
      }
    }
    @media (min-width: 900px) {
      .head {
        grid-template-columns: 200px minmax(0, 1fr);
        align-items: end;
        gap: var(--spacing-md);
      }
      .portrait {
        inline-size: 200px;
        block-size: 200px;
        margin-inline: 0;
      }
      .intro {
        text-align: left;
      }
      .meta,
      .actions {
        justify-content: flex-start;
      }
      .album .sleeve {
        --s: 128px;
      }
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
  `,
})
export class ArtistPage {
  private readonly artists = inject(ArtistsStore);
  private readonly images = inject(ArtistImageStore);
  private readonly playlists = inject(PlaylistsStore);
  protected readonly library = inject(LibraryStore);
  protected readonly player = inject(PlayerStore);
  private readonly trackArt = inject(TrackArtService);
  private readonly sourceFix = inject(SourceFixService);
  private readonly toast = inject(OrToast);
  private readonly router = inject(Router);

  /** Artist key from the `artist/:key` route (the router decodes it). */
  readonly key = input.required<string>();

  protected readonly artist = computed(() => this.artists.artist(this.key()));
  protected readonly loading = computed(
    () =>
      this.library.status() === 'loading' ||
      this.playlists.status() === 'loading',
  );

  /** The artist's portrait image, when one has been resolved. */
  protected readonly image = computed(() => {
    const a = this.artist();
    return a ? this.images.image(a.name)() : null;
  });
  /** Header fallback when there is no portrait: the first album's sleeve. */
  protected readonly cover = computed(
    () => this.artist()?.albums[0]?.coverTrack ?? null,
  );

  protected readonly libraryTracks = computed(
    () => this.artist()?.libraryTracks ?? NO_TRACKS,
  );
  protected readonly playlistOnly = computed(
    () => this.artist()?.playlistOnlyTracks ?? NO_TRACKS,
  );
  protected readonly albums = computed(() => this.artist()?.albums ?? []);

  protected readonly countLabel = computed(() => {
    const songs = this.libraryTracks().length + this.playlistOnly().length;
    const albums = this.albums().length;
    return `${plural(songs, 'song')} · ${plural(albums, 'album')}`;
  });

  /** Filter text as typed, and the filter the library list uses once typing settles. */
  protected readonly query = signal('');
  protected readonly listQuery = signal('');
  private readonly words = computed(() => filterWords(this.listQuery()));
  protected readonly filtering = computed(() => this.words().length > 0);
  protected readonly showFilter = computed(
    () => this.libraryTracks().length > PAGE_SIZE,
  );

  /** Library songs in list order, narrowed by the filter. */
  protected readonly libraryView = computed<readonly Track[]>(() => {
    const words = this.words();
    const tracks = this.libraryTracks();
    return words.length ? tracks.filter((t) => trackMatches(t, words)) : tracks;
  });
  protected readonly libraryWindow = lazyWindow(this.libraryView, () =>
    this.words().join(' '),
  );
  protected readonly playlistWindow = lazyWindow(this.playlistOnly);

  /** Plays and Shuffle cover every record: library songs, then playlist-only. */
  private readonly allTracks = computed<readonly Track[]>(() => [
    ...this.libraryTracks(),
    ...this.playlistOnly(),
  ]);

  /** Record whose options modal is open. */
  protected readonly optionsFor = signal<Track | null>(null);
  /** The ⋯ button that opened the options modal (for focus return). */
  private readonly optionsOrigin = signal<HTMLElement | null>(null);

  protected readonly art = (track: Track | null | undefined) =>
    this.trackArt.art(track);
  protected readonly formatDuration = formatDuration;

  protected albumDetail(album: {
    year?: number;
    tracks: readonly Track[];
  }): string {
    const songs = plural(album.tracks.length, 'song');
    return album.year ? `${album.year} · ${songs}` : songs;
  }

  /** Play or shuffle every record of this artist, in order. */
  protected async playAll(shuffle: boolean): Promise<void> {
    await this.playList(this.allTracks(), shuffle);
  }

  protected playLibraryFrom(index: number): Promise<void> {
    return this.playFromList(this.libraryView(), index);
  }

  protected playPlaylistFrom(index: number): Promise<void> {
    return this.playFromList(this.playlistOnly(), index);
  }

  private async playList(
    tracks: readonly Track[],
    shuffle: boolean,
  ): Promise<void> {
    if (!tracks.length) {
      this.toast.show(
        this.filtering()
          ? 'No records match your filter'
          : 'No records to play',
      );
      return;
    }
    const start = shuffle ? Math.floor(Math.random() * tracks.length) : 0;
    try {
      await this.player.playTracks(tracks, start, {
        shuffle,
        queue: 'playlist',
      });
    } catch {
      this.toast.show('Could not play this artist');
    }
  }

  private async playFromList(
    tracks: readonly Track[],
    index: number,
  ): Promise<void> {
    try {
      await this.player.playTracks(tracks, index, {
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

  /** Options: queue the optioned record to play next (front of Your Stack). */
  protected async playNext(): Promise<void> {
    const track = this.optionsFor();
    this.optionsFor.set(null);
    if (track) await this.playNextTrack(track);
  }

  /** Options: append the optioned record to Your Stack. */
  protected async addToStackFromOptions(): Promise<void> {
    const track = this.optionsFor();
    this.optionsFor.set(null);
    if (track) await this.addToStack(track);
  }

  /** Front of Your Stack, with a confirmation toast. */
  protected async playNextTrack(track: Track): Promise<void> {
    try {
      await this.player.playNext(track);
      this.toast.show(`“${track.title}” plays next`);
    } catch (err) {
      this.toast.show(
        err instanceof SessionRefusedError ? err.message : 'Could not queue that record. Try again.',
      );
    }
  }

  /** End of Your Stack, with a confirmation toast (also the row swipe). */
  protected async addToStack(track: Track): Promise<void> {
    try {
      await this.player.addToStack(track);
      this.toast.show(`“${track.title}” added to Your Stack`);
    } catch (err) {
      this.toast.show(
        err instanceof SessionRefusedError ? err.message : 'Could not add that record. Try again.',
      );
    }
  }

  protected goToLibrary(): void {
    void this.router.navigateByUrl('/library', { replaceUrl: true });
  }
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}
