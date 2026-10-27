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
  OfflineStore,
  PlayerStore,
  PlaylistsStore,
  REMOTE_PROVIDER_ID,
  SettingsStore,
  SyncStore,
  downloadState,
  filterTracks,
  formatDuration,
  sourceLabel,
} from '@open-record/state';
import {
  OrDownloadProgress,
  OrButton,
  OrEmptyState,
  OrFilterField,
  OrIcon,
  OrIconButton,
  OrLoadMore,
  OrSectionHead,
  OrSleeve,
  OrSpinner,
  OrSwitch,
  OrTag,
  OrToast,
  lazyWindow,
} from '@open-record/ui';
import { AddFromPlaylistDialog } from './add-from-playlist-dialog';
import { NewPlaylistDialog } from './new-playlist-dialog';
import { injectTrackArt } from './track-art';

/** Saved / imported record row styles (kept apart from the page sheet). */
const ROW_STYLES = `
    /* Record rows: title, artist · album, tags + detail; duration; bookmark. */
    .crate {
      display: grid;
    }
    .record {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto 44px;
      align-items: center;
      gap: var(--spacing-xs);
      padding: var(--spacing-xxs) 0;
      border-top: 1px solid
        color-mix(in srgb, var(--color-border) 32%, transparent);
    }
    .record:first-child {
      border-top: 0;
    }
    .record-main {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      gap: 10px;
      align-items: center;
      min-block-size: 72px;
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
    .record-main:hover {
      background: color-mix(in srgb, var(--color-text) 5%, transparent);
    }
    .record-main:focus-visible,
    .pl-row:focus-visible {
      outline: 2px solid var(--color-primary);
      outline-offset: 2px;
    }
    .info {
      display: grid;
      min-inline-size: 0;
    }
    .title,
    .artist {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .title {
      font-size: var(--type-row-title-font-size);
      font-weight: var(--type-row-title-font-weight);
      line-height: var(--type-row-title-line-height);
    }
    .is-current .title {
      color: var(--color-primary);
    }
    .artist {
      font-size: 13px;
      color: var(--color-muted);
    }
    .detail {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--spacing-xxs) var(--spacing-xs);
      margin-top: 3px;
      min-block-size: 23px;
      font-size: var(--type-meta-font-size);
      letter-spacing: var(--type-meta-letter-spacing);
      color: var(--color-muted);
    }
    .detail-text {
      min-inline-size: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    or-tag.tag-failed {
      color: var(--color-primary);
      border-color: color-mix(in srgb, var(--color-primary) 55%, transparent);
    }
    .dur {
      font-size: 12px;
      color: var(--color-muted);
      font-variant-numeric: tabular-nums;
      text-align: right;
    }
    .now {
      display: inline-flex;
      align-items: center;
      gap: var(--spacing-xs);
      color: var(--color-text);
    }

    @media (min-width: 900px) {
      .record,
      .record:first-child {
        border-top: 0;
        border-bottom: 1px solid
          color-mix(in srgb, var(--color-border) 32%, transparent);
      }
      .record-main {
        min-block-size: 64px;
      }
      .record-main:hover {
        background: var(--color-surface-raised);
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
    OrIconButton,
    OrLoadMore,
    OrSectionHead,
    OrSleeve,
    OrSpinner,
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
          <ul class="crate" aria-label="Saved records">
            @for (t of savedWindow.items(); track t.id; let i = $index) {
              <ng-container
                *ngTemplateOutlet="row; context: { $implicit: t, list: saved, pos: i + 1 }"
              />
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
        <ul class="crate" aria-label="Imported records">
          @for (t of importedWindow.items(); track t.id; let i = $index) {
            <ng-container
              *ngTemplateOutlet="row; context: { $implicit: t, list: imported, pos: i + 1 }"
            />
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

    <ng-template #row let-t let-list="list" let-pos="pos">
      @let current = player.isCurrent(t.id);
      @let saved = library.isSaved(t.id);
      @let status = offline.status(t.id);
      @let state = downloadState(status, offline.error(t.id));
      @let source = sourceLabel(t.source?.site);
      @let streamOnly = !status && t.providerId === remoteId;
      <li
        class="record"
        [class.is-current]="current"
        [attr.aria-setsize]="list.length"
        [attr.aria-posinset]="pos"
      >
        <button
          class="record-main"
          type="button"
          [attr.aria-label]="
            (current ? 'Now playing: ' : 'Play ') + t.title + ' by ' + t.artist
          "
          [attr.aria-current]="current ? 'true' : null"
          (click)="play(t, list)"
        >
          <or-sleeve
            size="thumb"
            [src]="art(t)"
            [alt]="''"
            [playing]="current && player.isPlaying()"
          />
          <span class="info">
            <span class="title">{{ t.title }}</span>
            <span class="artist">{{ t.artist }}@if (t.album) { · {{ t.album }}}</span>
            <span class="detail">
              @if (current) {
                <span class="now">
                  <or-icon name="disc" [size]="13" />
                  {{ player.isPlaying() ? 'On the turntable' : 'Paused' }}
                </span>
              }
              @if (source) {
                <or-tag>{{ source }}</or-tag>
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
                    <or-tag class="tag-failed" icon="alert" [attr.title]="offline.error(t.id)">{{ state.label }}</or-tag>
                  }
                }
              } @else if (streamOnly) {
                <or-tag>Streaming only</or-tag>
              }
              @if (!current) {
                <span class="detail-text">{{ detail(t) }}</span>
              }
            </span>
          </span>
        </button>
        <span class="dur">{{ formatDuration(t.durationSec) }}</span>
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
      </li>
    </ng-template>

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
    .pl-row:hover {
      background: var(--color-surface-raised);
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

    /* Desktop: records and playlists flow into responsive columns. */
    @media (min-width: 900px) {
      .crate {
        grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
        column-gap: var(--spacing-lg);
      }
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
      .record-main,
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
  protected readonly offline = inject(OfflineStore);
  private readonly sync = inject(SyncStore);
  private readonly toast = inject(OrToast);
  private readonly router = inject(Router);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  protected readonly dialogOpen = signal(false);
  protected readonly addFromPlaylistOpen = signal(false);
  protected readonly art = injectTrackArt();
  protected readonly remoteId = REMOTE_PROVIDER_ID;
  protected readonly downloadState = downloadState;
  protected readonly sourceLabel = sourceLabel;
  protected readonly formatDuration = formatDuration;

  /** Filter text for saved and imported records (component state only). */
  protected readonly query = signal('');
  protected readonly filtering = computed(() => this.query().trim().length > 0);
  protected readonly hasRecords = computed(
    () =>
      this.library.savedRecords().length > 0 ||
      this.library.importedTracks().length > 0,
  );
  /** Filtered lists: what rows render and what a row tap queues. */
  protected readonly savedShown = computed(() =>
    filterTracks(this.library.savedRecords(), this.query()),
  );
  protected readonly importedShown = computed(() =>
    filterTracks(this.library.importedTracks(), this.query()),
  );
  /** Rendered slices; reset to the first page when the filter changes. */
  protected readonly savedWindow = lazyWindow(this.savedShown, this.query);
  protected readonly importedWindow = lazyWindow(this.importedShown, this.query);
  protected readonly matchLabel = computed(() => {
    const n = this.savedShown().length + this.importedShown().length;
    const total =
      this.library.savedRecords().length + this.library.importedTracks().length;
    return `${n} of ${total} record${total === 1 ? '' : 's'} match`;
  });

  protected detail(t: Track): string {
    return [t.year, t.genre].filter(Boolean).join('  ·  ');
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
