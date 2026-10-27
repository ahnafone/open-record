import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  inject,
  signal,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import type { Playlist, Track } from '@open-record/models';
import {
  AutoDownloadStore,
  LibraryStore,
  PlayerStore,
  PlaylistsStore,
  SettingsStore,
  SyncStore,
  ariaSortFor,
  filterTracks,
  nextSort,
  sortArrowFor,
  sortByColumn,
  sourceLabel,
  type TrackSort,
  type TrackSortKey,
} from '@open-record/state';
import {
  OrDownloadProgress,
  OrButton,
  OrEmptyState,
  OrFilterField,
  OrIcon,
  OrLoadMore,
  OrModal,
  OrSectionHead,
  OrSwitch,
  OrTag,
  OrToast,
  lazyWindow,
} from '@open-record/ui';
import { AddFromPlaylistDialog } from './add-from-playlist-dialog';
import { OrLibraryRow } from './library-row';
import { NewPlaylistDialog } from './new-playlist-dialog';
import { injectTrackArt } from './track-art';

/** Which record list a sort header or row belongs to. */
type ListId = 'saved' | 'imported';

/** Saved / imported record list styles; the row body lives in `OrLibraryRow`. */
const ROW_STYLES = `
    /*
     * Record rows. Phone: title, artist · album, tags + detail; duration;
     * bookmark; options. Desktop (>= 900px): Album, Source and Date added
     * columns under a sortable header row.
     */
    .crate {
      display: grid;
    }
    .record,
    .head-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto 44px 44px;
      align-items: center;
      gap: var(--spacing-xs);
    }
    .list-head {
      display: none;
    }
    .record {
      padding: var(--spacing-xxs) 0;
      border-top: 1px solid
        color-mix(in srgb, var(--color-border) 32%, transparent);
      /* Long libraries: skip layout and paint for off-screen rows. */
      content-visibility: auto;
      contain-intrinsic-size: auto 77px;
      /* Paint containment would clip the play button's focus ring. */
      overflow-clip-margin: 4px;
    }
    .record:first-child {
      border-top: 0;
    }
    /* Playing row: faint coral tint (flat, no shadow). */
    .record:has(or-library-row.is-current) {
      background: color-mix(in srgb, var(--color-primary) 8%, transparent);
      border-radius: var(--rounded-md);
    }
    .pl-row:focus-visible,
    .sort:focus-visible {
      outline: 2px solid var(--color-primary);
      outline-offset: 2px;
    }
    .sort {
      appearance: none;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      min-block-size: 44px;
      max-inline-size: 100%;
      padding: 0 var(--spacing-xs);
      background: transparent;
      border: 0;
      border-radius: var(--rounded-md);
      color: var(--color-muted);
      font: inherit;
      font-size: var(--type-eyebrow-font-size);
      letter-spacing: var(--type-eyebrow-letter-spacing);
      text-transform: uppercase;
      white-space: nowrap;
      cursor: pointer;
      transition: color var(--duration-fast) var(--ease-standard);
    }
    [aria-sort='ascending'] .sort,
    [aria-sort='descending'] .sort {
      color: var(--color-text);
    }
    .sort-dir {
      font-size: 12px;
      letter-spacing: 0;
    }
    .sr-only {
      position: absolute;
      inline-size: 1px;
      block-size: 1px;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
    }
    @media (hover: hover) {
      .sort:hover {
        color: var(--color-text);
      }
    }
    @media (min-width: 900px) {
      .record,
      .head-row {
        grid-template-columns:
          minmax(0, 3fr) minmax(0, 2fr) minmax(72px, 1fr)
          104px 64px 44px 44px;
        gap: var(--spacing-sm);
        padding-inline: var(--spacing-xs);
      }
      .list-head {
        display: block;
      }
      .head-row {
        border-bottom: 1px solid
          color-mix(in srgb, var(--color-border) 55%, transparent);
      }
      .h-duration {
        display: flex;
        justify-content: flex-end;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .sort {
        transition-duration: 1ms;
      }
    }
`;

/**
 * "Your library": saved records, the user's imported records (when any) and
 * their playlists.
 */
@Component({
  selector: 'or-library-page',
  imports: [
    OrDownloadProgress,
    NgTemplateOutlet,
    RouterLink,
    AddFromPlaylistDialog,
    NewPlaylistDialog,
    OrButton,
    OrEmptyState,
    OrFilterField,
    OrIcon,
    OrLibraryRow,
    OrLoadMore,
    OrModal,
    OrSectionHead,
    OrSwitch,
    OrTag,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header class="head">
      <span class="eyebrow">Your shelves</span>
      <h1 class="display">Library</h1>
      <p class="lede">Saved sides and the playlists you make.</p>
    </header>

    @if (library.status() === 'ready' && hasRecords()) {
      <or-filter-field
        class="filter"
        label="Filter your records"
        placeholder="Filter by title, artist or album"
        describedBy="or-library-filter-status"
        [(value)]="query"
        (settledValue)="listQuery.set($event)"
      />
      <p id="or-library-filter-status" class="filter-status" role="status">
        @if (filtering()) {
          {{ matchLabel() }}
        }
      </p>
    }

    <or-section-head heading="Saved records">
      <or-button
        size="sm"
        [disabled]="library.status() !== 'ready'"
        (click)="addFromPlaylistOpen.set(true)"
      >
        <or-icon name="plus" [size]="18" />
        Add Songs from Playlist
      </or-button>
    </or-section-head>
    <or-switch
      label="Auto-download"
      description="Keep every saved record on this device for offline play."
      [checked]="settings.autoDownloadLibrary()"
      (checkedChange)="setAutoDownload($event)"
    />
    <p class="auto-note" role="status">
      @if (settings.autoDownloadLibrary()) {
        @if (autoDownload.waitingForWifi()) {
          Waiting for Wi-Fi. Allow mobile data in Settings to download now.
        } @else {
          @if (autoDownload.pauseReason(); as paused) {
            {{ paused }}
          } @else if (autoDownload.failedCount(library.savedIds()); as n) {
            <a class="failed-link" routerLink="/downloads/failed">{{ n }} couldn’t be downloaded</a>
          }
        }
      }
    </p>
    @if (libraryProgress(); as p) {
      <or-download-progress
        label="Library download progress"
        [saved]="p.saved"
        [total]="p.total"
        [fraction]="libraryFraction"
      />
    }
    @switch (library.status()) {
      @case ('loading') {
        <p class="status">Loading your records…</p>
      }
      @case ('error') {
        <p class="status error" role="alert">
          {{ library.error() || 'Could not load your library.' }}
        </p>
      }
      @default {
        @let saved = savedShown();
        @if (saved.length) {
          <ng-container *ngTemplateOutlet="sortHead; context: { $implicit: 'saved' }" />
          <ul class="crate" aria-label="Saved records">
            @for (t of savedWindow.items(); track t.id; let i = $index) {
              <li class="record" [attr.aria-setsize]="saved.length" [attr.aria-posinset]="i + 1">
                <or-library-row
                  [track]="t"
                  [art]="art(t)"
                  [addedAt]="library.savedAt(t.id)"
                  (playTrack)="play(t, saved)"
                  (toggleSave)="toggleSaved(t, $event)"
                  (options)="optionsFor.set(t)"
                />
              </li>
            }
          </ul>
          @if (savedWindow.hasMore()) {
            <div
              class="sentinel"
              orLoadMore
              [loadMoreKey]="savedWindow.items().length"
              (loadMore)="savedWindow.grow()"
            ></div>
          }
        } @else if (filtering() && library.savedRecords().length) {
          <or-empty-state>No saved records match “{{ query().trim() }}”.</or-empty-state>
        } @else {
          <or-empty-state>
            Nothing saved yet. Tap the bookmark on any record to keep it here.
          </or-empty-state>
        }
      }
    }

    @if (library.status() === 'ready' && library.importedTracks().length) {
      @let imported = importedShown();
      <or-section-head heading="Imported" />
      @if (imported.length) {
        <ng-container *ngTemplateOutlet="sortHead; context: { $implicit: 'imported' }" />
        <ul class="crate" aria-label="Imported records">
          @for (t of importedWindow.items(); track t.id; let i = $index) {
            <li class="record" [attr.aria-setsize]="imported.length" [attr.aria-posinset]="i + 1">
              <or-library-row
                [track]="t"
                [art]="art(t)"
                [addedAt]="library.importedAt(t.id)"
                (playTrack)="play(t, imported)"
                (toggleSave)="toggleSaved(t, $event)"
                (options)="optionsFor.set(t)"
              />
            </li>
          }
        </ul>
        @if (importedWindow.hasMore()) {
          <div
            class="sentinel"
            orLoadMore
            [loadMoreKey]="importedWindow.items().length"
            (loadMore)="importedWindow.grow()"
          ></div>
        }
      } @else {
        <or-empty-state>No imported records match “{{ query().trim() }}”.</or-empty-state>
      }
    }

    <or-section-head heading="Playlists">
      <or-button
        class="new-btn"
        size="sm"
        ariaLabel="New playlist"
        (click)="dialogOpen.set(true)"
      >
        <or-icon name="plus" [size]="18" />
        New
      </or-button>
    </or-section-head>
    @switch (playlists.status()) {
      @case ('loading') {
        <p class="status">Loading playlists…</p>
      }
      @case ('error') {
        <p class="status error" role="alert">
          {{ playlists.error() || 'Could not load playlists.' }}
        </p>
      }
      @default {
        @if (playlists.playlists().length) {
          <ul class="pl-list" aria-label="Playlists">
            @for (pl of playlists.playlists(); track pl.id) {
              <li>
                <a class="pl-row" [routerLink]="['/playlist', pl.id]">
                  <span class="pl-info">
                    <span class="pl-name">{{ pl.name }}</span>
                    <span class="pl-meta">{{ meta(pl) }}</span>
                  </span>
                  @if (pl.visibility === 'public') {
                    <or-tag icon="globe">Public</or-tag>
                  } @else {
                    <or-tag icon="lock">Private</or-tag>
                  }
                </a>
              </li>
            }
          </ul>
        } @else {
          <or-empty-state>
            No playlists yet. Create one and start filling the crate.
          </or-empty-state>
        }
      }
    }

    <p class="note">
      Saved records and playlists live on this device. No account, no server.
    </p>

    <!--
      Desktop-only sortable header for a record list (hidden below 900px).
      Sorting is view-only: ascending, descending, then the list's own order.
    -->
    <ng-template #sortHead let-list>
      <div
        class="list-head"
        role="table"
        [attr.aria-label]="list === 'saved' ? 'Sort saved records' : 'Sort imported records'"
      >
        <div class="head-row" role="row">
          @for (col of columns; track col.key) {
            <div
              role="columnheader"
              [class]="'h-' + col.key"
              [attr.aria-sort]="ariaSort(list, col.key)"
            >
              <button type="button" class="sort" (click)="cycleSort(list, col.key)">
                {{ col.label }}
                <span class="sort-dir" aria-hidden="true">{{ sortArrow(list, col.key) }}</span>
              </button>
            </div>
          }
          <div role="columnheader"><span class="sr-only">Saved</span></div>
          <div role="columnheader"><span class="sr-only">Options</span></div>
        </div>
      </div>
    </ng-template>

    <or-modal
      [open]="!!optionsFor()"
      [heading]="optionsFor()?.title ?? 'Record'"
      (dismissed)="optionsFor.set(null)"
    >
      <div orModalActions>
        <or-button block (click)="playNext()">Play next</or-button>
        <or-button block (click)="optionsFor.set(null)">Close</or-button>
      </div>
    </or-modal>

    <or-new-playlist-dialog
      [(open)]="dialogOpen"
      (created)="onCreated($event)"
    />
    <or-add-from-playlist-dialog
      [(open)]="addFromPlaylistOpen"
      (added)="onAddedFromPlaylist()"
    />
  `,
  // Two sheets so each stays inside the per-stylesheet budget.
  styles: [
    ROW_STYLES,
    `
    :host {
      display: block;
    }
    .head {
      margin: 2px 0 16px;
    }
    .eyebrow {
      font-size: var(--type-eyebrow-font-size);
      letter-spacing: var(--type-eyebrow-letter-spacing);
      text-transform: uppercase;
      color: var(--color-muted);
    }
    .display {
      margin: 0 0 5px;
      font-family: var(--type-display-font-family);
      font-size: var(--type-display-font-size);
      font-weight: var(--type-display-font-weight);
      line-height: var(--type-display-line-height);
    }
    .lede {
      margin: 0;
      font-size: var(--type-body-sm-font-size);
      color: var(--color-muted);
    }
    .filter {
      margin-block-end: var(--spacing-xxs);
    }
    /* Reserved so the list does not jump when the count appears. */
    .filter-status {
      margin: 0 0 var(--spacing-xs);
      min-block-size: 18px;
      font-size: 12px;
      line-height: 1.5;
      color: var(--color-muted);
      font-variant-numeric: tabular-nums;
    }
    .sentinel {
      block-size: 1px;
    }
    ul {
      list-style: none;
      margin: 0;
      padding: 0;
    }

    /* Link-style button to Fix failed downloads; 44px tall hit area. */
    .failed-link {
      display: inline-flex;
      align-items: center;
      min-block-size: var(--spacing-touch);
      margin-block: calc((18px - var(--spacing-touch)) / 2);
      color: var(--color-text);
      text-decoration: underline;
      text-underline-offset: 3px;
      border-radius: var(--rounded-md);
    }
    .failed-link:hover { color: var(--color-primary); }
    .failed-link:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 2px; }
    /* Reserved so the list does not jump when the note appears. */
    .auto-note {
      margin: 0 0 var(--spacing-xs);
      min-block-size: 18px;
      font-size: 12px;
      line-height: 1.5;
      color: var(--color-muted);
    }
    .status {
      margin: var(--spacing-sm) 0 0;
      min-block-size: 1.45em;
      font-size: var(--type-body-sm-font-size);
      color: var(--color-muted);
    }
    .status.error {
      color: var(--color-primary);
    }

    /* playlists */
    .pl-list {
      display: grid;
      gap: var(--spacing-sm);
    }
    .pl-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: var(--spacing-sm);
      align-items: center;
      min-block-size: 64px;
      padding: var(--spacing-sm) 10px var(--spacing-sm) var(--spacing-md);
      background: var(--color-surface);
      border: 1px solid color-mix(in srgb, var(--color-border) 50%, transparent);
      border-radius: var(--rounded-md);
      color: inherit;
      text-decoration: none;
      transition: background var(--duration-fast) var(--ease-standard);
    }
    @media (hover: hover) {
      .pl-row:hover {
        background: var(--color-surface-raised);
      }
    }
    .pl-info {
      display: grid;
      min-inline-size: 0;
    }
    .pl-name {
      font-family: var(--font-display);
      font-size: 18px;
      line-height: 1.25;
      overflow-wrap: anywhere;
    }
    .pl-meta {
      font-size: var(--type-meta-font-size);
      color: var(--color-muted);
    }

    /* Desktop: playlists flow into responsive columns; records stay one list. */
    @media (min-width: 900px) {
      .pl-list {
        grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
      }
    }
    .note {
      margin: 14px 0 0;
      font-size: var(--type-meta-font-size);
      color: var(--color-muted);
    }
    @media (prefers-reduced-motion: reduce) {
      .pl-row {
        transition-duration: 1ms;
      }
    }
  `,
  ],
})
export class LibraryPage {
  protected readonly library = inject(LibraryStore);
  protected readonly playlists = inject(PlaylistsStore);
  protected readonly player = inject(PlayerStore);
  protected readonly settings = inject(SettingsStore);
  protected readonly autoDownload = inject(AutoDownloadStore);
  /**
   * Download counts for saved records; null when nothing is downloading.
   * Status-only, so progress ticks do not re-check the whole list.
   */
  protected readonly libraryProgress = computed(() => {
    const c = this.autoDownload.countsFor(this.library.savedIds());
    return c.downloading ? c : null;
  });
  /** Live 0-1 fraction, read only by the progress bar. */
  protected readonly libraryFraction = computed(
    () => this.autoDownload.progressFor(this.library.savedIds()).fraction,
  );
  private readonly sync = inject(SyncStore);
  private readonly toast = inject(OrToast);
  private readonly router = inject(Router);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  protected readonly dialogOpen = signal(false);
  protected readonly addFromPlaylistOpen = signal(false);
  protected readonly art = injectTrackArt();

  /** Filter text as typed (the field and the "no match" copy). */
  protected readonly query = signal('');
  /**
   * The filter the lists use: `query` once typing pauses, so a keystroke
   * does not re-filter 2000 records or reset the rendered window.
   */
  protected readonly listQuery = signal('');
  protected readonly filtering = computed(() => this.listQuery().trim().length > 0);
  protected readonly hasRecords = computed(
    () =>
      this.library.savedRecords().length > 0 ||
      this.library.importedTracks().length > 0,
  );
  /** Desktop column headers. Sorting is view-only, per list. */
  protected readonly columns: readonly { key: TrackSortKey; label: string }[] = [
    { key: 'title', label: 'Title' },
    { key: 'album', label: 'Album' },
    { key: 'source', label: 'Source' },
    { key: 'added', label: 'Date added' },
    { key: 'duration', label: 'Duration' },
  ];
  /** `null` is the list's own order (saved: newest first; imported: index order). */
  protected readonly savedSort = signal<TrackSort | null>(null);
  protected readonly importedSort = signal<TrackSort | null>(null);
  /** Record whose options modal is open. */
  protected readonly optionsFor = signal<Track | null>(null);

  /** Filtered, sorted lists: what rows render and what a row tap queues. */
  protected readonly savedShown = computed(() =>
    sortByColumn(
      filterTracks(this.library.savedRecords(), this.listQuery()),
      this.savedSort(),
      (t, key) => this.sortValue(t, key, 'saved'),
    ),
  );
  protected readonly importedShown = computed(() =>
    sortByColumn(
      filterTracks(this.library.importedTracks(), this.listQuery()),
      this.importedSort(),
      (t, key) => this.sortValue(t, key, 'imported'),
    ),
  );
  /** Rendered slices; reset to the first page when the filter or sort changes. */
  protected readonly savedWindow = lazyWindow(
    this.savedShown,
    () => `${this.listQuery()}|${this.savedSort()?.key}|${this.savedSort()?.dir}`,
  );
  protected readonly importedWindow = lazyWindow(
    this.importedShown,
    () => `${this.listQuery()}|${this.importedSort()?.key}|${this.importedSort()?.dir}`,
  );
  protected readonly matchLabel = computed(() => {
    const n = this.savedShown().length + this.importedShown().length;
    const total =
      this.library.savedRecords().length + this.library.importedTracks().length;
    return `${n} of ${total} record${total === 1 ? '' : 's'} match`;
  });

  private sortValue(
    t: Track,
    key: TrackSortKey,
    list: ListId,
  ): string | number | undefined {
    switch (key) {
      case 'title':
        return t.title;
      case 'album':
        return t.album || undefined;
      case 'source':
        return sourceLabel(t.source?.site) ?? undefined;
      case 'added':
        return list === 'saved'
          ? this.library.savedAt(t.id)
          : this.library.importedAt(t.id);
      case 'duration':
        return t.durationSec || undefined;
    }
  }

  private sortOf(list: ListId) {
    return list === 'saved' ? this.savedSort : this.importedSort;
  }

  /** Header click: ascending, then descending, then back to the list's order. */
  protected cycleSort(list: ListId, key: TrackSortKey): void {
    const sort = this.sortOf(list);
    sort.set(nextSort(sort(), key));
  }

  protected ariaSort(list: ListId, key: TrackSortKey): 'ascending' | 'descending' | null {
    return ariaSortFor(this.sortOf(list)(), key);
  }

  protected sortArrow(list: ListId, key: TrackSortKey): string {
    return sortArrowFor(this.sortOf(list)(), key);
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

  protected meta(pl: Playlist): string {
    const n = pl.trackIds.length;
    return `${n} record${n === 1 ? '' : 's'}`;
  }

  protected async setAutoDownload(on: boolean): Promise<void> {
    try {
      await this.settings.setAutoDownload({ library: on });
    } catch {
      this.toast.show('Could not change auto-download. Try again.');
    }
  }

  protected play(track: Track, context: readonly Track[]): void {
    this.player.playTrack(track, context).catch(() => {
      this.toast.show(`Could not play “${track.title}”.`);
    });
  }

  protected async toggleSaved(track: Track, saved: boolean): Promise<void> {
    if (saved) return this.unsave(track);
    try {
      await this.library.setSaved(track.id, true);
      this.toast.show(`Saved “${track.title}” to your library`);
    } catch {
      this.toast.show(`Could not save “${track.title}”. Try again.`);
    }
  }

  protected async unsave(track: Track): Promise<void> {
    try {
      await this.library.setSaved(track.id, false);
      this.toast.show(`Removed “${track.title}” from your library`);
      // The row is gone: keep focus on the page instead of dropping to <body>.
      afterNextRender(
        () => {
          const root = this.host.nativeElement;
          const next =
            root.querySelector<HTMLElement>('.record or-icon-button button') ??
            root.querySelector<HTMLElement>('.new-btn button');
          next?.focus();
        },
        { injector: this.injector },
      );
    } catch {
      this.toast.show(`Could not remove “${track.title}”. Try again.`);
    }
  }

  protected onAddedFromPlaylist(): void {
    void this.sync.syncNow();
  }

  protected onCreated(pl: Playlist): void {
    this.toast.show('Playlist created');
    void this.router.navigate(['/playlist', pl.id]);
  }
}
