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
  ImportSessionsStore,
  ImportStore,
  LibraryStore,
  OfflineStore,
  PlayerStore,
  REMOTE_PROVIDER_ID,
  downloadState,
  formatDuration,
  formatSessionDate,
  importSessionCounts,
  sourceLabel,
  type ImportSession,
} from '@open-record/state';
import {
  OrButton,
  OrDialog,
  OrEmptyState,
  OrIcon,
  OrIconButton,
  OrLoadMore,
  OrSectionHead,
  OrSleeve,
  OrSpinner,
  OrTag,
  OrToast,
  lazyWindow,
  type SleeveSrc,
} from '@open-record/ui';
import { EditTrackDialog } from './edit-track-dialog';

/** One import run: what it added, playable, with edit/remove for imported files. */
@Component({
  selector: 'or-import-session-page',
  imports: [
    EditTrackDialog,
    OrButton,
    OrEmptyState,
    OrIcon,
    OrIconButton,
    OrLoadMore,
    OrSectionHead,
    OrSleeve,
    OrSpinner,
    OrTag,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (!loaded()) {
      <p class="status" role="status"><or-spinner [size]="16" />Loading…</p>
    } @else if (session(); as s) {
      <h1 class="heading">{{ s.label }}</h1>
      <p class="meta">{{ date(s.createdAt) }} · {{ counts(s) }}</p>

      <or-section-head heading="Records" />
      @if (tracks().length) {
        <ul class="crate">
          @for (t of trackWindow.items(); track t.id) {
            @let current = player.isCurrent(t.id);
            @let status = offline.status(t.id);
            @let state = downloadState(status, offline.error(t.id));
            @let source = sourceLabel(t.source?.site);
            @let imported = library.isImported(t);
            <li class="record" [class.is-current]="current" [class.has-actions]="imported">
              <button
                class="record-main"
                type="button"
                [attr.aria-label]="
                  (current ? 'Now playing: ' : 'Play ') + t.title + ' by ' + t.artist
                "
                [attr.aria-current]="current ? 'true' : null"
                (click)="play(t)"
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
                    } @else if (!status && t.providerId === remoteId) {
                      <or-tag>Streaming only</or-tag>
                    } @else if (t.providerId === 'spotify') {
                      <or-tag>Not matched yet</or-tag>
                    }
                  </span>
                </span>
              </button>
              <span class="dur">{{ formatDuration(t.durationSec) }}</span>
              @if (imported) {
                <span class="actions">
                  <or-button size="sm" [ariaLabel]="'Edit ' + t.title" (click)="editing.set(t)">
                    Edit
                  </or-button>
                  <or-icon-button
                    icon="trash"
                    [label]="'Remove ' + t.title"
                    (click)="remove(t)"
                  />
                </span>
              }
            </li>
          }
        </ul>
        @if (trackWindow.hasMore()) {
          <div
            class="sentinel"
            orLoadMore
            [loadMoreKey]="trackWindow.items().length"
            (loadMore)="trackWindow.grow()"
          ></div>
        }
      } @else {
        <or-empty-state>
          None of these records are in your library any more.
        </or-empty-state>
      }
      @if (missing(); as n) {
        <p class="note">
          {{ n }} record{{ n === 1 ? ' is' : 's are' }} no longer in your library.
        </p>
      }

      <div class="foot">
        <or-button variant="danger" block (click)="deleteSession()">
          <or-icon name="trash" [size]="18" />Delete session
        </or-button>
        <p class="note">Deleting the session keeps its records in your library.</p>
      </div>
    } @else {
      <or-empty-state>This import session no longer exists.</or-empty-state>
    }

    <or-edit-track-dialog
      [open]="!!editing()"
      (openChange)="$event || editing.set(null)"
      [track]="editing()"
    />
  `,
  styles: `
    :host {
      display: block;
      max-inline-size: 800px;
    }
    .status {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
      min-block-size: var(--spacing-touch);
      margin: 0;
      font-size: 12px;
      color: var(--color-muted);
    }
    .heading {
      margin: var(--spacing-xs) 0 var(--spacing-xs);
      font-family: var(--font-display);
      font-size: 24px;
      font-weight: 400;
      line-height: 1.2;
      overflow-wrap: anywhere;
    }
    .meta {
      margin: 0;
      font-size: 12px;
      color: var(--color-muted);
      font-variant-numeric: tabular-nums;
    }
    .crate {
      display: grid;
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .record {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: center;
      gap: var(--spacing-xs);
      padding: var(--spacing-xxs) 0;
      border-top: 1px solid
        color-mix(in srgb, var(--color-border) 32%, transparent);
    }
    .record.has-actions {
      grid-template-columns: minmax(0, 1fr) auto auto;
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
      color: var(--color-muted);
    }
    or-tag.tag-failed {
      color: var(--color-primary);
      border-color: color-mix(in srgb, var(--color-primary) 55%, transparent);
    }
    .now {
      display: inline-flex;
      align-items: center;
      gap: var(--spacing-xs);
      color: var(--color-text);
    }
    .dur {
      font-size: 12px;
      color: var(--color-muted);
      font-variant-numeric: tabular-nums;
      text-align: right;
    }
    .sentinel {
      block-size: 1px;
    }
    .actions {
      display: flex;
      align-items: center;
    }
    .note {
      margin: var(--spacing-sm) 0 0;
      font-size: 12px;
      color: var(--color-muted);
    }
    .foot {
      margin-top: var(--spacing-xl);
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
      .foot {
        max-inline-size: 336px;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .record-main {
        transition-duration: 1ms;
      }
    }
  `,
})
export class ImportSessionPage {
  /** Route param. */
  readonly id = input.required<string>();

  protected readonly library = inject(LibraryStore);
  protected readonly player = inject(PlayerStore);
  protected readonly offline = inject(OfflineStore);
  private readonly sessions = inject(ImportSessionsStore);
  private readonly imports = inject(ImportStore);
  private readonly dialog = inject(OrDialog);
  private readonly toast = inject(OrToast);
  private readonly router = inject(Router);

  protected readonly loaded = signal(false);
  protected readonly editing = signal<Track | null>(null);
  protected readonly remoteId = REMOTE_PROVIDER_ID;
  protected readonly downloadState = downloadState;
  protected readonly sourceLabel = sourceLabel;
  protected readonly formatDuration = formatDuration;
  protected readonly date = formatSessionDate;

  /** Live match counts for Spotify sessions. */
  protected counts(s: ImportSession): string {
    const states = this.imports.itemStates();
    return importSessionCounts(s, (key) => states.get(key));
  }

  protected readonly session = computed(() => this.sessions.session(this.id()));

  /** Session tracks still known to the library; Spotify placeholders follow their match. */
  private readonly resolved = computed(() => {
    const s = this.session();
    if (!s) return [];
    // Re-run when the job matches items or the library changes.
    this.imports.progress();
    return [...new Set(s.trackIds.map((id) => (s.kind === 'spotify' || s.kind === 'youtube' ? this.imports.resolveId(id) : id)))].map(
      (id) => this.library.track(id),
    );
  });
  protected readonly tracks = computed(() =>
    this.resolved().filter((t): t is Track => !!t),
  );
  /** Rendered rows (long imports grow a page at a time); play uses all. */
  protected readonly trackWindow = lazyWindow(this.tracks);
  protected readonly missing = computed(
    () => this.resolved().length - this.tracks().length,
  );

  private readonly artCache = new WeakMap<Track, Promise<string | undefined>>();

  constructor() {
    void Promise.all([
      this.sessions.load(),
      this.library.ready(),
      this.imports.ready(),
    ])
      .catch(() => undefined)
      .finally(() => this.loaded.set(true));
  }

  /** Sleeve art resolved at display time (memoized per track object). */
  protected art(track: Track): SleeveSrc {
    if (track.artUrl || !track.coverPath) return track.artUrl;
    let art = this.artCache.get(track);
    if (!art) {
      art = this.library.artUrl(track).catch(() => undefined);
      this.artCache.set(track, art);
    }
    return art;
  }

  protected play(track: Track): void {
    this.player.playTrack(track, this.tracks()).catch(() => {
      this.toast.show(`Could not play “${track.title}”.`);
    });
  }

  protected async remove(track: Track): Promise<void> {
    const ok = await this.dialog.confirm({
      title: 'Remove record?',
      message: `"${track.title}" and its file will be deleted from this device, and removed from playlists and the queue.`,
      confirmLabel: 'Remove record',
      danger: true,
    });
    if (!ok) return;
    try {
      await this.library.removeImported(track.id);
      this.toast.show('Record removed');
    } catch {
      this.toast.show('Could not remove that record. Try again.');
    }
  }

  protected async deleteSession(): Promise<void> {
    const s = this.session();
    if (!s) return;
    const ok = await this.dialog.confirm({
      title: 'Delete import session?',
      message:
        'Only this entry in your import history is deleted. Its records stay in your library and playlists.',
      confirmLabel: 'Delete session',
      danger: true,
    });
    if (!ok) return;
    try {
      await this.sessions.delete(s.id);
      this.toast.show('Import session deleted');
      await this.router.navigate(['/import/sessions'], { replaceUrl: true });
    } catch {
      this.toast.show('Could not delete the session. Try again.');
    }
  }
}
