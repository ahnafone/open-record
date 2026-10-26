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
import {
  AutoDownloadStore,
  LibraryStore,
  OfflineStore,
  PlayerStore,
  PlaylistsStore,
  REMOTE_PROVIDER_ID,
  downloadState,
  formatDuration,
  sourceLabel,
} from '@open-record/state';
import {
  OrButton,
  OrDialog,
  OrDisc,
  OrEmptyState,
  OrIcon,
  OrIconButton,
  OrModal,
  OrSectionHead,
  OrSleeve,
  OrSpinner,
  OrSwitch,
  OrTag,
  OrToast,
} from '@open-record/ui';
import { AddRecordsDialog } from './add-records-dialog';
import { RenamePlaylistDialog } from './rename-playlist-dialog';
import { formatAddedAt } from './row-format';
import { injectTrackArt } from './track-art';

type SortKey = 'title' | 'album' | 'source' | 'added' | 'duration';
interface SortState {
  key: SortKey;
  dir: 'asc' | 'desc';
}

/** A record row with its static (per playlist load) display values. */
interface Row {
  track: Track;
  /** Playlist index + id: stable across sorting, unique with duplicates. */
  key: string;
  duration: string;
  source: string | null;
  addedAt: number | undefined;
  added: string;
}

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

function sortValue(row: Row, key: SortKey): string | number | undefined {
  switch (key) {
    case 'title':
      return row.track.title;
    case 'album':
      return row.track.album || undefined;
    case 'source':
      return row.source ?? undefined;
    case 'added':
      return row.addedAt;
    case 'duration':
      return row.track.durationSec || undefined;
  }
}

/** Record row / desktop table styles (kept apart from the page sheet). */
const ROW_STYLES = `
    /*
     * Record rows. Phone: number, sleeve + title / artist · album / tags,
     * duration, bookmark, options. Desktop (>= 900px): a sortable table.
     */
    .tracks {
      display: grid;
    }
    .row {
      display: grid;
      grid-template-columns: 24px minmax(0, 1fr) auto 44px 44px;
      align-items: center;
      gap: var(--spacing-xs);
    }
    .head-group,
    .c-album,
    .c-source,
    .c-added {
      display: none;
    }
    .track {
      min-block-size: 60px;
      padding: 2px 0;
      border-top: 1px solid
        color-mix(in srgb, var(--color-border) 32%, transparent);
      /* Long playlists: skip layout and paint for off-screen rows. */
      content-visibility: auto;
      contain-intrinsic-size: auto 72px;
    }
    .track:first-child {
      border-top: 0;
    }
    .c-num {
      display: grid;
      place-items: center;
    }
    .num-btn {
      appearance: none;
      display: grid;
      place-items: center;
      inline-size: 100%;
      min-block-size: 44px;
      padding: 0;
      background: transparent;
      border: 0;
      border-radius: var(--rounded-md);
      color: var(--color-muted);
      font: inherit;
      font-size: 12px;
      font-variant-numeric: tabular-nums;
      cursor: pointer;
    }
    .num-btn > * {
      grid-area: 1 / 1;
    }
    .num-disc {
      display: block;
      inline-size: 20px;
    }
    .num-hover {
      visibility: hidden;
      color: var(--color-text);
    }
    .track:hover .num-hover,
    .track:focus-within .num-hover {
      visibility: visible;
    }
    .track:hover .num-idle,
    .track:focus-within .num-idle {
      visibility: hidden;
    }
    .is-current .num-hover {
      color: var(--color-primary);
    }
    .track-main {
      appearance: none;
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      align-items: center;
      gap: 10px;
      inline-size: 100%;
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
    .track-main:focus-visible,
    .sort:focus-visible {
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
      display: flex;
      flex-wrap: wrap;
      gap: var(--spacing-xs);
      margin-top: 3px;
    }
    or-tag.tag-failed {
      color: var(--color-primary);
      border-color: color-mix(in srgb, var(--color-primary) 55%, transparent);
    }
    .c-duration {
      font-size: 12px;
      color: var(--color-muted);
      font-variant-numeric: tabular-nums;
      text-align: right;
    }
    .c-album,
    .c-source,
    .c-added {
      min-inline-size: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 13px;
      color: var(--color-muted);
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
    .sort:hover,
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
    @media (min-width: 900px) {
      .row {
        grid-template-columns:
          40px minmax(0, 3fr) minmax(0, 2fr) minmax(72px, 1fr)
          104px 64px 44px 44px;
        gap: var(--spacing-sm);
        padding-inline: var(--spacing-xs);
      }
      .head-group,
      .c-album,
      .c-source,
      .c-added {
        display: block;
      }
      .head-row {
        border-bottom: 1px solid
          color-mix(in srgb, var(--color-border) 55%, transparent);
      }
      .head-row .c-num {
        display: grid;
      }
      .head-row .c-duration {
        display: flex;
        justify-content: flex-end;
      }
      .track {
        min-block-size: 64px;
        padding: 0 var(--spacing-xs);
        border-top: 0;
        border-radius: var(--rounded-md);
        contain-intrinsic-size: auto 68px;
        transition: background var(--duration-fast) var(--ease-standard);
      }
      .track:hover {
        background: var(--color-surface-raised);
      }
      .track-main {
        min-block-size: 64px;
        padding: 2px 0;
      }
      .track-main:hover {
        background: transparent;
      }
      .album-inline,
      .source-tag {
        display: none;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .track,
      .track-main,
      .sort {
        transition-duration: 1ms;
      }
    }
`;

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
    OrDisc,
    OrEmptyState,
    OrIcon,
    OrIconButton,
    OrModal,
    OrSectionHead,
    OrSleeve,
    OrSpinner,
    OrSwitch,
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

      <or-switch
        class="auto"
        label="Auto-download"
        description="Keep every record in this playlist on this device."
        [checked]="!!pl.autoDownload"
        (checkedChange)="setAutoDownload($event)"
      />
      <p class="auto-note" role="status">
        @if (pl.autoDownload && autoDownload.waitingForWifi()) {
          Waiting for Wi-Fi. Allow mobile data in Settings to download now.
        }
      </p>

      <or-section-head heading="Records" [level]="3" />
      @if (rows().length) {
        <div class="tracks" role="table" [attr.aria-label]="'Records in ' + pl.name">
          <div class="head-group" role="rowgroup">
            <div class="row head-row" role="row">
              <div
                class="c-num"
                role="columnheader"
                [attr.aria-sort]="sort() ? null : 'ascending'"
              >
                <button
                  type="button"
                  class="sort"
                  aria-label="Custom order"
                  title="Custom order"
                  (click)="sort.set(null)"
                >
                  #
                </button>
              </div>
              @for (col of columns; track col.key) {
                <div
                  role="columnheader"
                  [class]="'c-' + col.key"
                  [attr.aria-sort]="ariaSort(col.key)"
                >
                  <button type="button" class="sort" (click)="cycleSort(col.key)">
                    {{ col.label }}
                    <span class="sort-dir" aria-hidden="true">{{ sortArrow(col.key) }}</span>
                  </button>
                </div>
              }
              <div class="c-save" role="columnheader">
                <span class="sr-only">Saved</span>
              </div>
              <div class="c-more" role="columnheader">
                <span class="sr-only">Options</span>
              </div>
            </div>
          </div>
          <div class="body-group" role="rowgroup">
            @for (row of rows(); track row.key; let i = $index) {
              @let t = row.track;
              @let current = player.isCurrent(t.id);
              @let playing = current && player.isPlaying();
              @let saved = library.isSaved(t.id);
              @let status = offline.status(t.id);
              @let state = downloadState(status);
              @let imported = library.isImported(t);
              @let streamOnly = !status && t.providerId === remoteId;
              <div class="row track" role="row" [class.is-current]="current">
                <div class="c-num" role="cell">
                  <!-- Pointer shortcut; the title button is the accessible play control. -->
                  <button
                    type="button"
                    class="num-btn"
                    tabindex="-1"
                    aria-hidden="true"
                    (click)="numClick(i, current)"
                  >
                    @if (current) {
                      <span class="num-idle num-disc">
                        <or-disc [spinning]="playing" [showLabel]="false" />
                      </span>
                      <or-icon class="num-hover" [name]="playing ? 'pause' : 'play'" [size]="18" />
                    } @else {
                      <span class="num-idle">{{ i + 1 }}</span>
                      <or-icon class="num-hover" name="play" [size]="18" />
                    }
                  </button>
                </div>
                <div class="c-title" role="cell">
                  <button
                    type="button"
                    class="track-main"
                    [attr.aria-label]="playLabel(t, current)"
                    [attr.aria-current]="current ? 'true' : null"
                    (click)="playFrom(i)"
                  >
                    <or-sleeve [src]="art(t)" [label]="t.title" [playing]="playing" />
                    <span class="text">
                      <span class="title">{{ t.title }}</span>
                      <span class="artist">
                        {{ t.artist }}@if (t.album) {<span class="album-inline"> · {{ t.album }}</span>}
                      </span>
                      @if (imported || row.source || state || streamOnly) {
                        <span class="tags">
                          @if (imported) {
                            <or-tag ivory>Imported</or-tag>
                          }
                          @if (row.source) {
                            <or-tag class="source-tag">{{ row.source }}</or-tag>
                          }
                          @if (state) {
                            @switch (state.kind) {
                              @case ('saved') {
                                <or-tag icon="check">{{ state.label }}</or-tag>
                              }
                              @case ('downloading') {
                                <or-tag><or-spinner [size]="12" />{{ state.label }}</or-tag>
                              }
                              @case ('failed') {
                                <or-tag class="tag-failed" icon="alert">{{ state.label }}</or-tag>
                              }
                            }
                          } @else if (streamOnly) {
                            <or-tag>Streaming only</or-tag>
                          }
                        </span>
                      }
                    </span>
                  </button>
                </div>
                <div class="c-album" role="cell">{{ t.album ?? '' }}</div>
                <div class="c-source" role="cell">{{ row.source ?? '—' }}</div>
                <div class="c-added" role="cell">{{ row.added }}</div>
                <div class="c-duration" role="cell">{{ row.duration }}</div>
                <div class="c-save" role="cell">
                  <or-icon-button
                    icon="bookmark"
                    [pressed]="saved"
                    [label]="
                      (saved ? 'Remove ' : 'Save ') +
                      t.title +
                      (saved ? ' from' : ' to') +
                      ' your library'
                    "
                    (click)="toggleSaved(t, saved)"
                  />
                </div>
                <div class="c-more" role="cell">
                  <or-icon-button
                    icon="more"
                    [attr.data-options]="t.id"
                    [label]="'Options for ' + t.title"
                    (click)="optionsFor.set(t)"
                  />
                </div>
              </div>
            }
          </div>
        </div>
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
          <!-- Reordering only makes sense in the playlist's own order. -->
          @if (!sort()) {
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
          }
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
  // Two sheets so each stays inside the per-stylesheet budget.
  styles: [
    ROW_STYLES,
    `
    .auto {
      margin-top: var(--spacing-sm);
    }
    /* Reserved so the list does not jump when the note appears. */
    .auto-note {
      margin: 0;
      min-block-size: 18px;
      font-size: 12px;
      line-height: 1.5;
      color: var(--color-muted);
    }
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
    .actions {
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
  `,
  ],
})
export class PlaylistPage {
  private readonly playlists = inject(PlaylistsStore);
  protected readonly library = inject(LibraryStore);
  protected readonly offline = inject(OfflineStore);
  protected readonly autoDownload = inject(AutoDownloadStore);
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

  /** Desktop column headers (after `#`). Sorting is view-only. */
  protected readonly columns: readonly { key: SortKey; label: string }[] = [
    { key: 'title', label: 'Title' },
    { key: 'album', label: 'Album' },
    { key: 'source', label: 'Source' },
    { key: 'added', label: 'Date added' },
    { key: 'duration', label: 'Duration' },
  ];
  protected readonly remoteId = REMOTE_PROVIDER_ID;
  protected readonly downloadState = downloadState;
  /** `null` is the playlist's custom order. */
  protected readonly sort = signal<SortState | null>(null);

  /** Rows in playlist order; formatted once per playlist change, not per check. */
  private readonly baseRows = computed<Row[]>(() => {
    const addedAt = this.playlist()?.addedAt;
    return this.tracks().map((track, i) => {
      const at = addedAt?.[track.id];
      return {
        track,
        key: `${i}:${track.id}`,
        duration: formatDuration(track.durationSec),
        source: sourceLabel(track.source?.site),
        addedAt: at,
        added: formatAddedAt(at),
      };
    });
  });
  /** Rows in display order (what Play, Shuffle and row taps play). */
  protected readonly rows = computed<Row[]>(() => {
    const rows = this.baseRows();
    const sort = this.sort();
    if (!sort) return rows;
    const dir = sort.dir === 'asc' ? 1 : -1;
    // Stable sort: ties keep playlist order; unknown values always sink.
    return [...rows].sort((a, b) => {
      const av = sortValue(a, sort.key);
      const bv = sortValue(b, sort.key);
      if (av === undefined || bv === undefined) {
        return av === bv ? 0 : av === undefined ? 1 : -1;
      }
      const c =
        typeof av === 'number' && typeof bv === 'number'
          ? av - bv
          : collator.compare(String(av), String(bv));
      return c * dir;
    });
  });
  private readonly displayedTracks = computed(() => this.rows().map((r) => r.track));

  /** Header click: ascending, then descending, then back to custom order. */
  protected cycleSort(key: SortKey): void {
    const s = this.sort();
    if (s?.key !== key) this.sort.set({ key, dir: 'asc' });
    else if (s.dir === 'asc') this.sort.set({ key, dir: 'desc' });
    else this.sort.set(null);
  }

  protected ariaSort(key: SortKey): 'ascending' | 'descending' | null {
    const s = this.sort();
    if (s?.key !== key) return null;
    return s.dir === 'asc' ? 'ascending' : 'descending';
  }

  protected sortArrow(key: SortKey): string {
    const s = this.sort();
    if (s?.key !== key) return '';
    return s.dir === 'asc' ? '↑' : '↓';
  }

  protected async setAutoDownload(on: boolean): Promise<void> {
    try {
      await this.playlists.setAutoDownload(this.id(), on);
    } catch {
      this.toast.show('Could not change auto-download. Try again.');
    }
  }

  protected readonly renameOpen = signal(false);
  protected readonly addOpen = signal(false);
  /** Record whose options modal is open. */
  protected readonly optionsFor = signal<Track | null>(null);
  protected readonly optionIndex = computed(() => {
    const t = this.optionsFor();
    return t ? this.tracks().findIndex((x) => x.id === t.id) : -1;
  });

  protected playLabel(track: Track, current: boolean): string {
    const now = current ? ', now playing' : '';
    return `Play ${track.title} by ${track.artist}${now}`;
  }

  /** Play or shuffle the records in the order they are displayed. */
  protected async play(shuffle: boolean): Promise<void> {
    const tracks = this.displayedTracks();
    if (!tracks.length) {
      this.toast.show('This playlist has no records yet');
      return;
    }
    const start = shuffle ? Math.floor(Math.random() * tracks.length) : 0;
    try {
      await this.player.playTracks(tracks, start, { shuffle });
    } catch {
      this.toast.show('Could not play this playlist');
    }
  }

  /** Play from a displayed row, queueing the displayed order. */
  protected async playFrom(index: number): Promise<void> {
    try {
      await this.player.playTracks(this.displayedTracks(), index, {
        shuffle: false,
      });
    } catch {
      this.toast.show('Could not play that record');
    }
  }

  /** Number cell: toggle the current record, otherwise play from that row. */
  protected numClick(index: number, current: boolean): void {
    if (current) void this.player.togglePlay();
    else void this.playFrom(index);
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
