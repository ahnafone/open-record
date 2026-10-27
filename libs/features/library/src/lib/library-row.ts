import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
} from '@angular/core';
import type { Track } from '@open-record/models';
import {
  LibraryStore,
  OfflineStore,
  PlayerStore,
  REMOTE_PROVIDER_ID,
  downloadState,
  formatAddedAt,
  formatDuration,
  sourceLabel,
} from '@open-record/state';
import {
  OrIcon,
  OrIconButton,
  OrSleeve,
  OrSpinner,
  OrTag,
  type SleeveSrc,
} from '@open-record/ui';

/**
 * Body of one saved / imported record row: play button (sleeve, title,
 * artist · album, tags + detail), the desktop-only Album / Source / Date
 * added cells, duration, bookmark and options. The page owns the
 * `<li class="record">` (grid, list semantics, `aria-setsize`/`posinset`);
 * this host is `display: contents` so its children are the grid cells.
 * Reading the player / library / offline stores here keeps a status change
 * on one record from re-diffing every rendered row through the page.
 * Actions are outputs so the page keeps toasts and focus restoration.
 */
@Component({
  selector: 'or-library-row',
  imports: [OrIcon, OrIconButton, OrSleeve, OrSpinner, OrTag],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[class.is-current]': 'current()',
  },
  template: `
    @let t = track();
    @let isCurrent = current();
    @let isSaved = saved();
    <button
      class="record-main"
      type="button"
      [attr.aria-label]="
        (isCurrent ? 'Now playing: ' : 'Play ') + t.title + ' by ' + t.artist
      "
      [attr.aria-current]="isCurrent ? 'true' : null"
      (click)="playTrack.emit()"
    >
      <or-sleeve
        size="thumb"
        [src]="art()"
        [alt]="''"
        [playing]="isCurrent && player.isPlaying()"
      />
      <span class="info">
        <span class="title">{{ t.title }}</span>
        <span class="artist">{{ t.artist }}@if (t.album) {<span class="album-inline"> · {{ t.album }}</span>}</span>
        <span class="detail">
          @if (source(); as src) {
            <or-tag class="source-tag">{{ src }}</or-tag>
          }
          @if (state(); as s) {
            @switch (s.kind) {
              @case ('saved') {
                <or-tag icon="check">{{ s.label }}</or-tag>
              }
              @case ('downloading') {
                <or-tag><or-spinner [size]="12" />{{ s.label }}</or-tag>
              }
              @case ('failed') {
                <or-tag class="tag-failed" icon="alert" [attr.title]="error()">{{ s.label }}</or-tag>
              }
            }
          } @else if (streamOnly()) {
            <or-tag>Streaming only</or-tag>
          }
          @if (!isCurrent) {
            <span class="detail-text">{{ detail() }}</span>
          }
        </span>
        @if (isCurrent) {
          <span class="now">
            <or-icon name="disc" [size]="13" />
            {{ player.isPlaying() ? 'On the turntable' : 'Paused' }}
          </span>
        }
      </span>
    </button>
    <!-- Desktop table cells (hidden below 900px, where the row shows them inline). -->
    <span class="c-album">{{ t.album ?? '' }}</span>
    <span class="c-source">{{ source() ?? '—' }}</span>
    <span class="c-added">{{ added() }}</span>
    <span class="dur">{{ duration() }}</span>
    <or-icon-button
      icon="bookmark"
      [pressed]="isSaved"
      [label]="
        (isSaved ? 'Remove ' : 'Save ') +
        t.title +
        (isSaved ? ' from' : ' to') +
        ' your library'
      "
      (click)="toggleSave.emit(isSaved)"
    />
    <or-icon-button
      icon="more"
      [label]="'Options for ' + t.title"
      (click)="options.emit()"
    />
  `,
  styles: `
    :host {
      /* The page's <li class="record"> grid lays out this row's cells. */
      display: contents;
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
    }
    .record-main:focus-visible {
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
    :host(.is-current) .title {
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
    .c-album,
    .c-source,
    .c-added {
      display: none;
      min-inline-size: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 13px;
      color: var(--color-muted);
    }
    .now {
      display: flex;
      align-items: center;
      gap: var(--spacing-xs);
      margin-top: 2px;
      font-size: var(--type-meta-font-size);
      line-height: 16px;
      color: var(--color-text);
    }

    /* Hover only where a pointer can hover: no unused transitions on touch. */
    @media (hover: hover) {
      .record-main {
        transition: background var(--duration-fast) var(--ease-standard);
      }
      .record-main:hover {
        background: color-mix(in srgb, var(--color-text) 5%, transparent);
      }
    }
    @media (min-width: 900px) {
      .record-main {
        min-block-size: 64px;
      }
      .c-album,
      .c-source,
      .c-added {
        display: block;
      }
      /* The columns carry these on desktop. */
      .album-inline,
      .source-tag {
        display: none;
      }
    }
    @media (min-width: 900px) and (hover: hover) {
      .record-main:hover {
        background: var(--color-surface-raised);
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .record-main {
        transition-duration: 1ms;
      }
    }
  `,
})
export class OrLibraryRow {
  readonly track = input.required<Track>();
  /** Resolved sleeve art (the page memoizes it per track). */
  readonly art = input<SleeveSrc>(null);
  /** When the record joined this list (epoch ms); shown as `—` when unknown. */
  readonly addedAt = input<number | undefined>(undefined);
  /** Row tap: play this record in the page's list order. */
  readonly playTrack = output<void>();
  /** Bookmark tap; emits whether the record was saved before the tap. */
  readonly toggleSave = output<boolean>();
  /** Options button tap (Play next). */
  readonly options = output<void>();

  protected readonly player = inject(PlayerStore);
  private readonly library = inject(LibraryStore);
  private readonly offline = inject(OfflineStore);

  protected readonly current = computed(() =>
    this.player.isCurrent(this.track().id),
  );
  protected readonly saved = computed(() =>
    this.library.isSaved(this.track().id),
  );
  private readonly status = computed(() =>
    this.offline.status(this.track().id),
  );
  protected readonly error = computed(() =>
    this.offline.error(this.track().id),
  );
  protected readonly state = computed(() =>
    downloadState(this.status(), this.error()),
  );
  protected readonly streamOnly = computed(
    () => !this.status() && this.track().providerId === REMOTE_PROVIDER_ID,
  );
  protected readonly source = computed(() =>
    sourceLabel(this.track().source?.site),
  );
  protected readonly duration = computed(() =>
    formatDuration(this.track().durationSec),
  );
  protected readonly added = computed(() => formatAddedAt(this.addedAt()));
  protected readonly detail = computed(() => {
    const t = this.track();
    return [t.year, t.genre].filter(Boolean).join('  ·  ');
  });
}
