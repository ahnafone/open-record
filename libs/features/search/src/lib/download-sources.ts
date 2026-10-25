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
  DownloadsStore,
  SettingsStore,
  isAbort,
  remoteErrorMessage,
  type DownloadItem,
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
} from '@open-record/ui';

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
 * "Download sources" on the Search screen: search a site on the user's
 * download server, paste a link, and download records into the library.
 * Shows a compact list of running and failed downloads with retry.
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
    RouterLink,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <or-section-head heading="Download sources" />

    @if (!settings.hydrated()) {
      <p class="status" role="status">
        <span class="status-load"><or-spinner [size]="14" />Loading…</span>
      </p>
    } @else if (
      !settings.downloadsAvailable || !settings.downloadServerConfigured()
    ) {
      <or-empty-state class="setup">
        @if (settings.downloadsAvailable) {
          Set up your download server to find and download records from YouTube,
          SoundCloud and more.
          <a class="link-btn" routerLink="/settings">Open Settings</a>
        } @else {
          Downloading is not available in this build.
        }
      </or-empty-state>
    } @else {
      <div class="chips" role="group" aria-label="Download source">
        @for (s of sources; track s.site) {
          <or-chip
            [toggleable]="false"
            [selected]="site() === s.site"
            (click)="site.set(s.site)"
            >{{ s.label }}</or-chip
          >
        }
      </div>

      <p id="or-dl-status" class="status" role="status">
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
          aria-describedby="or-dl-status"
        >
          @for (t of found(); track t.id) {
            <ng-container *ngTemplateOutlet="row; context: { $implicit: t }" />
          }
        </ul>
      }

      <form class="paste" (submit)="resolveLink($event)">
        <label class="eyebrow" for="or-dl-link">Paste a link</label>
        <div class="paste-row">
          <span class="field" [class.is-bad]="!!linkError()">
            <or-icon class="field-ic" name="link" />
            <input
              id="or-dl-link"
              type="url"
              inputmode="url"
              autocomplete="off"
              placeholder="https://…"
              aria-describedby="or-dl-link-status"
              [attr.aria-invalid]="linkError() ? 'true' : null"
              [value]="link()"
              (input)="onLink($event)"
            />
          </span>
          <or-button type="submit" [disabled]="resolving() || !link().trim()">
            {{ resolving() ? 'Finding…' : 'Find' }}
          </or-button>
        </div>
        <p id="or-dl-link-status" class="status" role="status">
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
          <ng-container *ngTemplateOutlet="row; context: { $implicit: r }" />
        </ul>
      }

      @if (downloads.visible().length) {
        <h3 class="eyebrow queue-head">Downloads</h3>
        <ul class="queue" aria-label="Downloads">
          @for (d of downloads.visible(); track d.id) {
            <li class="queue-item">
              <span class="q-text">
                <span class="q-title">{{ d.title }}</span>
                <span class="q-status" [class.is-bad]="d.phase === 'failed'">
                  {{ d.phase === 'failed' ? d.error : statusText(d) }}
                </span>
              </span>
              @if (d.phase === 'failed') {
                <or-button
                  size="sm"
                  [ariaLabel]="'Retry ' + d.title"
                  (click)="downloads.retry(d.id)"
                >
                  Retry
                </or-button>
              }
              <or-icon-button
                icon="close"
                [iconSize]="20"
                [label]="
                  (d.phase === 'failed' ? 'Dismiss ' : 'Cancel ') + d.title
                "
                (click)="downloads.dismiss(d.id)"
              />
              @if (isActive(d)) {
                <or-progress-line
                  class="q-progress"
                  [value]="d.progress"
                  [max]="100"
                />
              }
            </li>
          }
        </ul>
      }
      <p class="sr-only" aria-live="polite">
        @if (downloads.lastSaved(); as s) {
          Saved {{ s.title }} to your library.
        }
      </p>
      <p class="note">
        You are responsible for what you download. See the
        <a routerLink="/settings" fragment="music-disclaimer"
          >music disclaimer</a
        >.
      </p>
    }

    <ng-template #row let-t>
      @let item = downloads.itemFor(t.source?.url);
      <li class="row">
        <or-sleeve
          size="thumb"
          [src]="t.artUrl"
          [label]="t.title"
          fallbackLabel="No artwork"
        />
        <span class="info">
          <span class="title">{{ t.title }}</span>
          <span class="artist">{{ t.artist }}</span>
          <span class="detail" [class.is-bad]="item?.phase === 'failed'">
            {{ rowDetail(t, item) }}
          </span>
        </span>
        <span class="action">
          @if (item?.phase === 'done') {
            <or-tag ivory icon="check">Saved</or-tag>
          } @else if (item?.phase === 'saving') {
            <or-spinner [size]="18" label="Saving" />
          } @else if (item && item.phase !== 'failed') {
            <or-icon-button
              icon="close"
              [iconSize]="20"
              [label]="'Cancel ' + t.title"
              (click)="downloads.dismiss(item.id)"
            />
          } @else {
            <or-button
              size="sm"
              [ariaLabel]="(item ? 'Retry ' : 'Download ') + t.title"
              (click)="download(t)"
            >
              <or-icon name="download" [size]="18" />{{
                item ? 'Retry' : 'Download'
              }}
            </or-button>
          }
        </span>
      </li>
    </ng-template>
  `,
  styles: `
    :host {
      display: block;
    }
    .sr-only {
      position: absolute;
      inline-size: 1px;
      block-size: 1px;
      margin: -1px;
      padding: 0;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
      border: 0;
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
    a:focus-visible {
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
    .status-bad,
    .is-bad {
      color: var(--color-primary);
    }

    .rows,
    .queue {
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
      grid-template-columns: auto minmax(0, 1fr) auto;
      align-items: center;
      gap: 10px;
      min-block-size: 72px;
      padding: var(--spacing-xs) 0;
      border-block-start: 1px solid
        color-mix(in srgb, var(--color-border) 32%, transparent);
    }
    .row:first-child {
      border-block-start: 0;
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
    .artist {
      font-size: 13px;
      line-height: 1.35;
      color: var(--color-muted);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .detail {
      min-block-size: calc(
        var(--type-meta-font-size) * var(--type-meta-line-height)
      );
      font-size: var(--type-meta-font-size);
      line-height: var(--type-meta-line-height);
      color: var(--color-muted);
      font-variant-numeric: tabular-nums;
    }
    .detail.is-bad {
      color: var(--color-primary);
    }
    .action {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-inline-size: var(--spacing-touch);
      min-block-size: var(--spacing-touch);
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

    .queue-head {
      margin-block-start: var(--spacing-md);
    }
    .queue-item {
      position: relative;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto auto;
      align-items: center;
      gap: var(--spacing-xs);
      min-block-size: 60px;
      border-block-start: 1px solid
        color-mix(in srgb, var(--color-border) 32%, transparent);
    }
    .queue-item:first-child {
      border-block-start: 0;
    }
    .q-text {
      display: grid;
      min-inline-size: 0;
    }
    .q-title {
      font-size: 14px;
      font-weight: 600;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .q-status {
      font-size: 12px;
      color: var(--color-muted);
      font-variant-numeric: tabular-nums;
    }
    .q-status.is-bad {
      color: var(--color-primary);
    }
    .q-progress {
      position: absolute;
      inset-inline: 0;
      inset-block-end: 0;
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
  protected readonly downloads = inject(DownloadsStore);

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
      this.settings.downloadServerConfigured() && this.query()
        ? { q: this.query(), site: this.site() }
        : undefined,
    loader: ({ params, abortSignal }) =>
      this.downloads.search(params.q, params.site, abortSignal),
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

  protected message(err: unknown): string {
    return remoteErrorMessage(err);
  }

  protected isActive(d: DownloadItem): boolean {
    return (
      d.phase === 'downloading' ||
      d.phase === 'processing' ||
      d.phase === 'saving'
    );
  }

  protected statusText(d: DownloadItem): string {
    switch (d.phase) {
      case 'queued':
        return 'Waiting…';
      case 'downloading':
        return `Downloading ${d.progress}%`;
      case 'processing':
        return 'Processing…';
      case 'saving':
        return 'Saving to your library…';
      case 'done':
        return 'In your library';
      default:
        return '';
    }
  }

  protected rowDetail(t: Track, item: DownloadItem | undefined): string {
    if (item?.phase === 'failed') return item.error ?? 'Download failed.';
    if (item) return this.statusText(item);
    return formatDuration(t.durationSec);
  }

  protected download(t: Track): void {
    try {
      this.downloads.enqueue(t);
    } catch (err) {
      this.linkError.set(remoteErrorMessage(err));
    }
  }

  protected onLink(event: Event): void {
    this.link.set((event.target as HTMLInputElement).value);
    this.linkError.set(null);
  }

  protected async resolveLink(event: Event): Promise<void> {
    event.preventDefault();
    const url = this.link().trim();
    if (!url || this.resolving()) return;
    if (!/^https?:\/\/\S+$/i.test(url)) {
      this.linkError.set('Paste a full http:// or https:// link.');
      return;
    }
    this.linkAbort?.abort();
    const abort = (this.linkAbort = new AbortController());
    this.resolving.set(true);
    this.linkError.set(null);
    try {
      const track = await this.downloads.resolve(url, abort.signal);
      if (!abort.signal.aborted) this.resolved.set(track);
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
