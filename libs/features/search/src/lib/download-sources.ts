import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  resource,
  signal,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { RouterLink } from '@angular/router';
import type { DownloadSite, Track } from '@open-record/models';
import {
  LibraryStore,
  OfflineStore,
  PlayerStore,
  REMOTE_PROVIDER_ID,
  RemoteServerPort,
  SettingsStore,
  isAbort,
  remoteErrorMessage,
} from '@open-record/state';
import {
  OrButton,
  OrChip,
  OrEmptyState,
  OrIcon,
  OrIconButton,
  OrProgressLine,
  OrSectionHead,
  OrSleeve,
  OrSpinner,
  OrTag,
  OrToast,
} from '@open-record/ui';
import { PlaylistPickerDialog } from './playlist-picker-dialog';

/** Sites with server search, as chips. Other sites work through a pasted link. */
export const SEARCHABLE_SOURCES: readonly {
  site: DownloadSite;
  label: string;
}[] = [
  { site: 'youtube', label: 'YouTube' },
  { site: 'ytmusic', label: 'YouTube Music' },
  { site: 'soundcloud', label: 'SoundCloud' },
];

/** `m:ss` for a duration in seconds. */
export function formatDuration(sec: number | undefined): string {
  if (!sec || sec < 0) return '';
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * "Find online" on the Search screen: search a site on the stream server or
 * paste a link. Tapping a record plays it (streamed unless saved); the
 * bookmark saves it to the device for offline play.
 */
@Component({
  selector: 'or-download-sources',
  imports: [
    NgTemplateOutlet,
    OrButton,
    OrChip,
    OrEmptyState,
    OrIcon,
    OrIconButton,
    OrProgressLine,
    OrSectionHead,
    OrSleeve,
    OrSpinner,
    OrTag,
    PlaylistPickerDialog,
    RouterLink,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <or-section-head heading="Find online" />

    @if (!settings.hydrated()) {
      <p class="status" role="status">
        <span class="status-load"><or-spinner [size]="14" />Loading…</span>
      </p>
    } @else if (!settings.serverAvailable || !settings.downloadServerConfigured()) {
      <or-empty-state class="setup">
        @if (settings.serverAvailable) {
          Set up your stream server to find records on YouTube, SoundCloud and
          more.
          <a class="link-btn" routerLink="/settings">Open Settings</a>
        } @else {
          Online search is not available in this build.
        }
      </or-empty-state>
    } @else {
      <div class="chips" role="group" aria-label="Search source">
        @for (s of sources; track s.site) {
          <or-chip
            [toggleable]="false"
            [selected]="site() === s.site"
            (click)="site.set(s.site)"
            >{{ s.label }}</or-chip
          >
        }
      </div>

      <p id="or-find-status" class="status" role="status">
        @if (!query()) {
          <span class="status-idle"
            >Search above to look on {{ siteLabel() }}.</span
          >
        } @else if (results.isLoading()) {
          <span class="status-load">
            <or-spinner [size]="14" />Searching {{ siteLabel() }}…
          </span>
        } @else if (results.error(); as err) {
          <span class="status-bad">
            <or-icon name="alert" [size]="14" />{{ message(err) }}
          </span>
        } @else if (results.hasValue()) {
          <span class="status-idle"
            >{{ resultLabel() }} on {{ siteLabel() }}</span
          >
        }
      </p>

      @if (query() && found().length) {
        <ul
          class="rows"
          [class.is-stale]="results.isLoading()"
          aria-describedby="or-find-status"
        >
          @for (t of found(); track t.id) {
            <ng-container
              *ngTemplateOutlet="row; context: { $implicit: t, list: found() }"
            />
          }
        </ul>
      }

      <form class="paste" (submit)="resolveLink($event)">
        <label class="eyebrow" for="or-find-link">Paste a link</label>
        <div class="paste-row">
          <span class="field" [class.is-bad]="!!linkError()">
            <or-icon class="field-ic" name="link" />
            <input
              id="or-find-link"
              type="url"
              inputmode="url"
              autocomplete="off"
              placeholder="https://…"
              aria-describedby="or-find-link-status"
              [attr.aria-invalid]="linkError() ? 'true' : null"
              [value]="link()"
              (input)="onLink($event)"
            />
          </span>
          <or-button type="submit" [disabled]="resolving() || !link().trim()">
            {{ resolving() ? 'Finding…' : 'Find' }}
          </or-button>
        </div>
        <p id="or-find-link-status" class="status" role="status">
          @if (linkError(); as e) {
            <span class="status-bad"
              ><or-icon name="alert" [size]="14" />{{ e }}</span
            >
          } @else {
            <span class="status-idle"
              >Bandcamp, Audiomack, Mixcloud and other links work here.</span
            >
          }
        </p>
      </form>
      @if (resolved(); as r) {
        <ul class="rows" aria-label="Pasted link">
          <ng-container
            *ngTemplateOutlet="row; context: { $implicit: r, list: [r] }"
          />
        </ul>
      }

      <p class="note">
        Saved records are copied to this device. Other records stream from the
        server. You are responsible for what you use. See the
        <a routerLink="/settings" fragment="music-disclaimer"
          >music disclaimer</a
        >.
      </p>
    }

    <ng-template #row let-t let-list="list">
      @let st = offline.status(t.id);
      <li class="row">
        <button type="button" class="main" (click)="play(t, list)">
          <or-sleeve
            size="thumb"
            [src]="t.artUrl"
            [label]="t.title"
            fallbackLabel="No artwork"
          />
          <span class="info">
            <span class="title" [class.is-current]="player.isCurrent(t.id)">{{
              t.title
            }}</span>
            <span class="artist">{{ t.artist }}</span>
            <span class="tags">
              @if (st === 'saved') {
                <or-tag ivory icon="check">Saved offline</or-tag>
              } @else if (t.providerId === REMOTE && !st) {
                <or-tag>Streaming only</or-tag>
              }
              @if (t.durationSec) {
                <span class="detail">{{ duration(t.durationSec) }}</span>
              }
            </span>
          </span>
        </button>
        <span class="actions">
          <or-icon-button
            icon="bookmark"
            [iconSize]="20"
            [pressed]="library.isSaved(t.id)"
            [label]="
              (library.isSaved(t.id) ? 'Remove bookmark for ' : 'Bookmark ') +
              t.title
            "
            (click)="toggleSaved(t)"
          />
          <or-icon-button
            icon="plus"
            [iconSize]="20"
            [label]="'Add ' + t.title + ' to a playlist'"
            (click)="openPicker(t)"
          />
        </span>
        @if (st === 'queued' || st === 'saving') {
          <span class="line">
            <span class="status-load">
              {{ st === 'queued' ? 'Waiting to save…' : 'Saving offline…' }}
            </span>
            <or-progress-line
              [value]="offline.progress(t.id) * 100"
              [max]="100"
            />
          </span>
        } @else if (st === 'failed') {
          <span class="line">
            <span class="status-bad">
              <or-icon name="alert" [size]="14" />{{
                offline.error(t.id) ?? 'Could not save offline.'
              }}
            </span>
            <or-button
              size="sm"
              [ariaLabel]="'Retry saving ' + t.title"
              (click)="offline.retry(t.id)"
            >
              Retry
            </or-button>
          </span>
        }
      </li>
    </ng-template>

    <or-playlist-picker-dialog [(open)]="pickerOpen" [track]="pickerTrack()" />
  `,
  styles: `
    :host {
      display: block;
    }
    .setup {
      display: grid;
      justify-items: center;
      gap: var(--spacing-sm);
      margin-block-start: var(--spacing-sm);
    }
    .link-btn {
      display: inline-flex;
      align-items: center;
      min-block-size: var(--spacing-touch);
      padding: 0 14px;
      color: var(--color-text);
      font-size: 15px;
      text-decoration: none;
      background: var(--color-surface);
      border: 1px solid color-mix(in srgb, var(--color-border) 75%, transparent);
      border-radius: var(--rounded-md);
    }
    a:focus-visible,
    button:focus-visible {
      outline: 2px solid var(--color-primary);
      outline-offset: 2px;
    }
    .chips {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-block-start: var(--spacing-sm);
    }

    /* Reserved status lines: never collapse, so content does not jump. */
    .status {
      margin: var(--spacing-xxs) 0 var(--spacing-xs);
      min-block-size: calc(
        var(--type-meta-font-size) * var(--type-meta-line-height)
      );
      font-size: var(--type-meta-font-size);
      line-height: var(--type-meta-line-height);
      letter-spacing: var(--type-meta-letter-spacing);
    }
    .status-load,
    .status-bad,
    .status-idle {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      color: var(--color-muted);
    }
    .status-bad {
      color: var(--color-primary);
    }

    .rows {
      display: grid;
      margin: 0;
      padding: 0;
      list-style: none;
      transition: opacity var(--duration-fast) var(--ease-standard);
    }
    .rows.is-stale {
      opacity: 0.6;
    }
    .row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: center;
      gap: 4px 6px;
      min-block-size: 72px;
      padding: var(--spacing-xs) 0;
      border-block-start: 1px solid
        color-mix(in srgb, var(--color-border) 32%, transparent);
    }
    .row:first-child {
      border-block-start: 0;
    }
    .main {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      align-items: center;
      gap: 10px;
      min-inline-size: 0;
      min-block-size: var(--spacing-touch);
      padding: 0;
      text-align: start;
      color: inherit;
      font: inherit;
      background: none;
      border: 0;
      cursor: pointer;
    }
    .info {
      display: grid;
      gap: var(--spacing-xxs);
      min-inline-size: 0;
    }
    .title {
      font-size: var(--type-row-title-font-size);
      font-weight: var(--type-row-title-font-weight);
      line-height: var(--type-row-title-line-height);
      overflow-wrap: anywhere;
    }
    .title.is-current {
      color: var(--color-primary);
    }
    .artist {
      font-size: 13px;
      line-height: 1.35;
      color: var(--color-muted);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .tags {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--spacing-xxs) 6px;
    }
    .detail {
      font-size: var(--type-meta-font-size);
      color: var(--color-muted);
      font-variant-numeric: tabular-nums;
    }
    .actions {
      display: inline-flex;
      align-items: center;
    }
    .line {
      grid-column: 1 / -1;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--spacing-xxs) 10px;
      min-block-size: calc(
        var(--type-meta-font-size) * var(--type-meta-line-height)
      );
      font-size: var(--type-meta-font-size);
      line-height: var(--type-meta-line-height);
    }
    .line or-progress-line {
      flex: 1 1 100%;
    }

    .paste {
      display: grid;
      gap: var(--spacing-xs);
      margin-block-start: var(--spacing-md);
    }
    .eyebrow {
      margin: 0;
      font-size: 11px;
      font-weight: 400;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--color-muted);
    }
    .paste-row {
      display: flex;
      gap: var(--spacing-sm);
    }
    .field {
      flex: 1 1 0;
      min-inline-size: 0;
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
      padding: 0 var(--spacing-sm);
      background: var(--color-background);
      border: 1px solid var(--color-border);
      border-radius: var(--rounded-md);
      transition: border-color var(--duration-fast) var(--ease-standard);
    }
    .field:focus-within,
    .field.is-bad {
      border-color: var(--color-primary);
    }
    .field-ic {
      color: var(--color-muted);
    }
    .field input {
      flex: 1 1 0;
      min-inline-size: 0;
      min-block-size: var(--spacing-touch);
      padding: 0;
      border: 0;
      outline: none;
      background: transparent;
      color: var(--color-text);
      font: inherit;
    }
    .field input::placeholder {
      color: var(--color-muted);
    }
    .note {
      margin: var(--spacing-md) 0 0;
      font-size: 12px;
      line-height: 1.45;
      color: var(--color-muted);
    }
    .note a {
      color: var(--color-text);
    }

    @media (prefers-reduced-motion: reduce) {
      .rows,
      .field {
        transition-duration: 1ms;
      }
    }
  `,
})
export class DownloadSources {
  protected readonly settings = inject(SettingsStore);
  protected readonly library = inject(LibraryStore);
  protected readonly player = inject(PlayerStore);
  protected readonly offline = inject(OfflineStore);
  private readonly server = inject(RemoteServerPort, { optional: true });
  private readonly toast = inject(OrToast);

  protected readonly REMOTE = REMOTE_PROVIDER_ID;
  protected readonly duration = formatDuration;

  /** Settled, valid search text from the Search screen ('' for none). */
  readonly query = input('');

  protected readonly sources = SEARCHABLE_SOURCES;
  protected readonly site = signal<DownloadSite>('youtube');
  protected readonly siteLabel = computed(
    () => this.sources.find((s) => s.site === this.site())?.label ?? '',
  );

  /** Server search; a new query or site aborts the stale request. */
  protected readonly results = resource({
    params: () =>
      this.settings.downloadServerConfigured() && this.query() && this.server
        ? { q: this.query(), site: this.site() }
        : undefined,
    loader: async ({ params, abortSignal }) => {
      const server = this.server;
      if (!server) return [];
      const tracks = await server.searchSite(params.q, params.site, abortSignal);
      this.library.remember(tracks);
      return tracks;
    },
  });

  protected readonly found = computed(() =>
    this.results.hasValue() ? this.results.value() : [],
  );
  protected readonly resultLabel = computed(() => {
    const n = this.found().length;
    return n ? `${n} result${n === 1 ? '' : 's'}` : 'No results';
  });

  protected readonly link = signal('');
  protected readonly linkError = signal<string | null>(null);
  protected readonly resolving = signal(false);
  protected readonly resolved = signal<Track | null>(null);
  private linkAbort?: AbortController;

  protected readonly pickerOpen = signal(false);
  protected readonly pickerTrack = signal<Track | null>(null);

  protected message(err: unknown): string {
    return remoteErrorMessage(err);
  }

  protected play(track: Track, list: readonly Track[]): void {
    this.library.remember([track]);
    void this.player.playTrack(track, list);
  }

  /** Bookmark (save offline) or un-bookmark; OfflineStore reports progress. */
  protected async toggleSaved(track: Track): Promise<void> {
    this.library.remember([track]);
    try {
      await this.library.toggleSaved(track.id);
    } catch (err) {
      this.toast.show(remoteErrorMessage(err));
    }
  }

  protected openPicker(track: Track): void {
    this.library.remember([track]);
    this.pickerTrack.set(track);
    this.pickerOpen.set(true);
  }

  protected onLink(event: Event): void {
    this.link.set((event.target as HTMLInputElement).value);
    this.linkError.set(null);
  }

  protected async resolveLink(event: Event): Promise<void> {
    event.preventDefault();
    const url = this.link().trim();
    if (!url || this.resolving() || !this.server) return;
    if (!/^https?:\/\/\S+$/i.test(url)) {
      this.linkError.set('Paste a full http:// or https:// link.');
      return;
    }
    this.linkAbort?.abort();
    const abort = (this.linkAbort = new AbortController());
    this.resolving.set(true);
    this.linkError.set(null);
    try {
      const track = await this.server.resolveUrl(url, abort.signal);
      if (!abort.signal.aborted) {
        this.library.remember([track]);
        this.resolved.set(track);
      }
    } catch (err) {
      if (!abort.signal.aborted && !isAbort(err)) {
        this.resolved.set(null);
        this.linkError.set(remoteErrorMessage(err));
      }
    } finally {
      if (this.linkAbort === abort) this.resolving.set(false);
    }
  }
}
