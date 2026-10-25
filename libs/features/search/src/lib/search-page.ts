import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  linkedSignal,
  resource,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import type { Track } from '@open-record/models';
import {
  LibraryStore,
  PlayerStore,
  type OnlineRecording,
} from '@open-record/state';
import {
  OrButton,
  OrChip,
  OrEmptyState,
  OrIcon,
  OrIconButton,
  OrSectionHead,
  OrSleeve,
  OrSpinner,
  OrTag,
  OrToast,
} from '@open-record/ui';
import {
  MAX_QUERY_LENGTH,
  ONLINE_DEBOUNCE_MS,
  SEARCH_DEBOUNCE_MS,
  suggestionChips,
  toProviderQuery,
} from './search-query';
import { injectTrackArt } from './track-art';

/**
 * Search screen: a search field, genre/decade suggestion chips and record rows
 * from every searchable provider (title, artist, year or genre). Typing is
 * debounced; chips and "Clear search" apply at once. Tapping a row plays it
 * with the results as the queue; the bookmark saves it to the library.
 * Imported records are matched locally and tagged "Imported".
 *
 * When online metadata is available (native, setting on), an "Online" section
 * below lists info-only MusicBrainz matches: no play button, never queued.
 * MusicBrainz allows 1 request per second, so the online query only fires
 * after `ONLINE_DEBOUNCE_MS` of idle typing (or at once on Enter or a chip).
 */
@Component({
  selector: 'or-search-page',
  imports: [
    OrButton,
    OrChip,
    OrEmptyState,
    OrIcon,
    OrIconButton,
    OrSectionHead,
    OrSleeve,
    OrSpinner,
    OrTag,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1 class="sr-only">Search</h1>

    <label class="search-field" for="or-search-input">
      <or-icon class="search-ic" name="search" />
      <input
        #searchInput
        id="or-search-input"
        type="search"
        placeholder="Title, artist, year or genre"
        autocomplete="off"
        enterkeyhint="search"
        aria-label="Search the record shop"
        aria-describedby="or-search-status"
        [attr.aria-invalid]="tooLong() ? 'true' : null"
        [value]="query()"
        (input)="onInput($event)"
        (keydown.enter)="settleNow()"
      />
    </label>

    <p id="or-search-status" class="status" role="status">
      @if (tooLong()) {
        <span class="status-bad">
          <or-icon name="alert" [size]="14" />
          Keep searches under {{ maxLength }} characters.
        </span>
      } @else if (results.isLoading()) {
        <span class="status-load">
          <or-spinner [size]="14" />
          Searching…
        </span>
      } @else if (results.error()) {
        <span class="status-bad">
          <or-icon name="alert" [size]="14" />
          Search failed. Try again.
        </span>
      } @else if (hasQuery() && results.hasValue()) {
        <span class="sr-only">{{ countLabel() }} found</span>
      }
    </p>

    <div class="chips" role="group" aria-label="Suggestions">
      @for (s of chips(); track s) {
        <or-chip
          [toggleable]="false"
          [selected]="isChip(s)"
          (click)="pick(s)"
          >{{ s }}</or-chip
        >
      }
    </div>

    @if (!hasQuery()) {
      <or-empty-state class="empty">
        Search the shop. Try an artist, a year, or a bin like “{{
          exampleBin()
        }}”.
      </or-empty-state>
    } @else if (showNoResults()) {
      <or-empty-state class="empty">
        No records match “{{ settledText() }}”.
      </or-empty-state>
      <or-button class="clear" block (click)="clear()">Clear search</or-button>
    } @else if (hits().length && !results.error()) {
      <or-section-head [heading]="countLabel()" />
      <ul class="crate" [class.is-stale]="results.isLoading()">
        @for (t of hits(); track t.id) {
          @let current = player.isCurrent(t.id);
          @let saved = library.isSaved(t.id);
          <li class="record" [class.is-current]="current">
            <button
              class="record-main"
              type="button"
              [attr.aria-label]="rowLabel(t, current)"
              [attr.aria-current]="current ? 'true' : null"
              (click)="play(t, current)"
            >
              <or-sleeve
                size="thumb"
                [src]="art(t)"
                [playing]="current && player.isPlaying()"
              />
              <span class="info">
                <span class="title">{{ t.title }}</span>
                <span class="artist">{{ t.artist }}</span>
                @if (detail(t); as d) {
                  <span class="detail">{{ d }}</span>
                }
                @let imported = library.isImported(t);
                @if (current || imported || t.tags?.length) {
                  <span class="tags">
                    @if (current) {
                      <or-tag ivory icon="disc">{{
                        player.isPlaying() ? 'Now playing' : 'On the turntable'
                      }}</or-tag>
                    }
                    @if (imported) {
                      <or-tag ivory>Imported</or-tag>
                    }
                    @for (tag of t.tags?.slice(0, 2); track tag) {
                      <or-tag>{{ tag }}</or-tag>
                    }
                  </span>
                }
              </span>
            </button>
            <or-icon-button
              icon="bookmark"
              [pressed]="saved"
              [label]="
                (saved ? 'Remove ' : 'Save ') +
                t.title +
                (saved ? ' from' : ' to') +
                ' your library'
              "
              (click)="toggleSave(t)"
            />
          </li>
        }
      </ul>
    }

    @if (showOnline()) {
      <section class="online" aria-labelledby="or-online-head">
        <or-section-head id="or-online-head" heading="Online" />
        <p class="online-note">
          <or-icon name="globe" [size]="14" />
          Info only, not playable
        </p>
        <p class="status" role="status">
          @if (onlinePending()) {
            <span class="status-load">
              <or-spinner [size]="14" />
              Looking up MusicBrainz…
            </span>
          } @else if (onlineHits().length === 0) {
            <span class="status-load">No online matches.</span>
          } @else {
            <span class="status-load">{{ onlineCountLabel() }}</span>
          }
        </p>
        @if (onlineHits().length) {
          <ul class="online-list" [class.is-stale]="onlinePending()">
            @for (r of onlineHits(); track r.recordingMbid) {
              <li class="online-row">
                <span class="title">{{ r.title }}</span>
                <span class="artist">{{ r.artist }}</span>
                @if (onlineDetail(r); as d) {
                  <span class="detail">{{ d }}</span>
                }
                @if (r.genres.length) {
                  <span class="tags">
                    @for (g of r.genres.slice(0, 3); track g) {
                      <or-tag>{{ g }}</or-tag>
                    }
                  </span>
                }
              </li>
            }
          </ul>
        }
        <p class="attribution">
          Online results from MusicBrainz (CC0), not part of your library.
        </p>
      </section>
    }
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

    /* Search field: 48px surface well, 44px input, coral when focused or invalid. */
    .search-field {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
      min-block-size: 48px;
      padding: 0 var(--spacing-sm);
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      border-radius: var(--rounded-md);
      transition: border-color var(--duration-fast) var(--ease-standard);
    }
    .search-field:focus-within,
    .search-field:has(input[aria-invalid='true']) {
      border-color: var(--color-primary);
    }
    .search-ic {
      color: var(--color-muted);
    }
    input {
      flex: 1 1 0;
      min-inline-size: 0;
      min-block-size: var(--spacing-touch);
      padding: 0;
      border: 0;
      outline: none;
      background: transparent;
      color: var(--color-text);
      font: inherit;
      -webkit-appearance: none;
      appearance: none;
    }
    input::placeholder {
      color: var(--color-muted);
    }
    input::-webkit-search-cancel-button {
      -webkit-appearance: none;
    }

    /* Reserved status line: never collapses, so results do not jump. */
    .status {
      margin: var(--spacing-xxs) 0 var(--spacing-xs);
      min-block-size: calc(var(--type-meta-font-size) * var(--type-meta-line-height));
      font-size: var(--type-meta-font-size);
      line-height: var(--type-meta-line-height);
      letter-spacing: var(--type-meta-letter-spacing);
    }
    .status-load,
    .status-bad {
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .status-load {
      color: var(--color-muted);
    }
    .status-bad {
      color: var(--color-primary);
    }

    .chips {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }

    .empty {
      margin-block-start: var(--spacing-lg);
    }
    .clear {
      margin-block-start: var(--spacing-sm);
    }

    /* Record rows: separated by hairlines, not boxed. */
    .crate {
      display: grid;
      margin: 0;
      padding: 0;
      list-style: none;
      transition: opacity var(--duration-fast) var(--ease-standard);
    }
    .crate.is-stale {
      opacity: 0.6;
    }
    .record {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: center;
      gap: var(--spacing-xs);
      padding: var(--spacing-xxs) 0;
      border-block-start: 1px solid
        color-mix(in srgb, var(--color-border) 32%, transparent);
    }
    .record:first-child {
      border-block-start: 0;
    }
    .record-main {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      align-items: center;
      gap: 10px;
      min-block-size: 72px;
      min-inline-size: 0;
      padding: var(--spacing-xs) var(--spacing-sm) var(--spacing-xs)
        var(--spacing-xs);
      background: transparent;
      border: 0;
      border-radius: var(--rounded-md);
      color: inherit;
      font: inherit;
      text-align: start;
      cursor: pointer;
      transition:
        background var(--duration-fast) var(--ease-standard),
        transform var(--duration-fast) var(--ease-standard);
    }
    .record-main:hover {
      background: color-mix(in srgb, var(--color-text) 5%, transparent);
    }
    .record-main:active {
      transform: scale(0.97);
    }
    .record-main:focus-visible {
      outline: 2px solid var(--color-primary);
      outline-offset: 2px;
    }
    .info {
      display: grid;
      gap: var(--spacing-xxs);
      min-inline-size: 0;
    }
    .info > span {
      min-inline-size: 0;
    }
    .title {
      font-size: var(--type-row-title-font-size);
      font-weight: var(--type-row-title-font-weight);
      line-height: var(--type-row-title-line-height);
      overflow-wrap: anywhere;
    }
    .record.is-current .title {
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
    .detail {
      font-size: var(--type-meta-font-size);
      line-height: var(--type-meta-line-height);
      letter-spacing: var(--type-meta-letter-spacing);
      color: var(--color-muted);
    }
    .tags {
      display: flex;
      flex-wrap: wrap;
      gap: var(--spacing-xs);
      margin-block-start: 1px;
    }

    /* Online: info-only rows, plain text (no button, no play affordance). */
    .online {
      margin-block-start: var(--spacing-lg);
    }
    .online-note {
      display: flex;
      align-items: center;
      gap: 6px;
      margin: var(--spacing-xs) 0 0;
      font-size: var(--type-eyebrow-font-size);
      letter-spacing: var(--type-eyebrow-letter-spacing);
      text-transform: uppercase;
      color: var(--color-muted);
    }
    .online-list {
      display: grid;
      margin: 0;
      padding: 0;
      list-style: none;
      transition: opacity var(--duration-fast) var(--ease-standard);
    }
    .online-list.is-stale {
      opacity: 0.6;
    }
    .online-row {
      display: grid;
      align-content: center;
      gap: var(--spacing-xxs);
      min-block-size: 60px;
      padding: var(--spacing-xs) var(--spacing-xs);
      border-block-start: 1px solid
        color-mix(in srgb, var(--color-border) 32%, transparent);
    }
    .online-row:first-child {
      border-block-start: 0;
    }
    .online-row .title {
      font-size: 14px;
    }
    .attribution {
      margin: var(--spacing-sm) 0 0;
      font-size: var(--type-meta-font-size);
      line-height: var(--type-meta-line-height);
      color: var(--color-muted);
    }

    @media (prefers-reduced-motion: reduce) {
      .online-list,
      .search-field,
      .crate,
      .record-main {
        transition-duration: 1ms;
      }
      .record-main:active {
        transform: none;
      }
    }
  `,
})
export class SearchPage {
  protected readonly library = inject(LibraryStore);
  protected readonly player = inject(PlayerStore);
  private readonly toast = inject(OrToast);
  protected readonly art = injectTrackArt();
  private readonly searchInput =
    viewChild.required<ElementRef<HTMLInputElement>>('searchInput');

  protected readonly maxLength = MAX_QUERY_LENGTH;

  /** What is in the field right now. */
  protected readonly query = signal('');
  /** `query` after the user stops typing for `SEARCH_DEBOUNCE_MS`. */
  private readonly settled = signal('');

  protected readonly settledText = computed(() => this.settled().trim());
  protected readonly tooLong = computed(
    () => this.query().trim().length > MAX_QUERY_LENGTH,
  );
  protected readonly hasQuery = computed(
    () => !!this.settledText() && !this.tooLong(),
  );

  protected readonly results = resource({
    params: () =>
      this.hasQuery() ? toProviderQuery(this.settledText()) : undefined,
    loader: ({ params }) => this.library.search(params),
  });

  /** Latest results, kept on screen (dimmed) while the next search loads. */
  protected readonly hits = linkedSignal<Track[] | undefined, Track[]>({
    source: () => (this.results.hasValue() ? this.results.value() : undefined),
    computation: (next, prev) => next ?? prev?.value ?? [],
  });

  protected readonly showNoResults = computed(
    () => this.results.hasValue() && this.results.value().length === 0,
  );

  protected readonly countLabel = computed(() => {
    const n = this.hits().length;
    return `${n} record${n === 1 ? '' : 's'}`;
  });

  /** `query` after `ONLINE_DEBOUNCE_MS` idle (MusicBrainz allows 1 req/s). */
  private readonly onlineQuery = signal('');
  private readonly onlineText = computed(() => {
    const q = this.onlineQuery().trim();
    return q.length > MAX_QUERY_LENGTH ? '' : q;
  });

  /** The Online section exists only where lookups can run. */
  protected readonly showOnline = computed(
    () => this.library.onlineAvailable() && this.hasQuery(),
  );

  protected readonly online = resource({
    params: () =>
      this.library.onlineAvailable() && this.onlineText()
        ? this.onlineText()
        : undefined,
    loader: ({ params }) => this.library.onlineSearch(params),
  });

  /** Latest online matches, kept (dimmed) while the next lookup runs. */
  protected readonly onlineHits = linkedSignal<
    OnlineRecording[] | undefined,
    OnlineRecording[]
  >({
    source: () => (this.online.hasValue() ? this.online.value() : undefined),
    computation: (next, prev) => next ?? prev?.value ?? [],
  });

  /** Typing has not settled for the online query yet, or it is loading. */
  protected readonly onlinePending = computed(
    () =>
      this.onlineText() !== this.query().trim() || this.online.isLoading(),
  );

  protected readonly onlineCountLabel = computed(() => {
    const n = this.onlineHits().length;
    return `${n} online match${n === 1 ? '' : 'es'}`;
  });

  protected readonly chips = computed(() =>
    suggestionChips(this.library.tracks()),
  );
  protected readonly exampleBin = computed(
    () => this.chips()[0] ?? 'Ragtime',
  );

  constructor() {
    // Debounce typing; chips, Enter and Clear settle immediately.
    effect((onCleanup) => {
      const q = this.query();
      if (q === untracked(this.settled)) return;
      const timer = setTimeout(() => this.settled.set(q), SEARCH_DEBOUNCE_MS);
      onCleanup(() => clearTimeout(timer));
    });
    // Online lookups wait longer: never one per keystroke.
    effect((onCleanup) => {
      const q = this.query();
      if (q === untracked(this.onlineQuery)) return;
      const timer = setTimeout(() => this.onlineQuery.set(q), ONLINE_DEBOUNCE_MS);
      onCleanup(() => clearTimeout(timer));
    });
  }

  protected onInput(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
  }

  protected settleNow(): void {
    this.settled.set(this.query());
    this.onlineQuery.set(this.query());
  }

  protected isChip(label: string): boolean {
    return this.settledText().toLowerCase() === label.toLowerCase();
  }

  protected pick(label: string): void {
    this.setQuery(this.isChip(label) ? '' : label);
  }

  protected clear(): void {
    this.setQuery('');
    this.searchInput().nativeElement.focus();
  }

  protected detail(t: Track): string {
    return [t.year, t.genre].filter(Boolean).join('  ·  ');
  }

  protected onlineDetail(r: OnlineRecording): string {
    return [r.album, r.year].filter(Boolean).join('  ·  ');
  }

  protected rowLabel(t: Track, current: boolean): string {
    const verb = current && this.player.isPlaying() ? 'Pause' : 'Play';
    return `${verb} ${t.title} by ${t.artist}`;
  }

  protected play(track: Track, current: boolean): void {
    const run = current
      ? this.player.togglePlay()
      : this.player.playTrack(track, this.hits());
    run.catch(() => this.toast.show(`Couldn’t play “${track.title}”`));
  }

  protected async toggleSave(track: Track): Promise<void> {
    try {
      const saved = await this.library.toggleSaved(track.id);
      this.toast.show(
        saved
          ? `Saved “${track.title}” to your library`
          : `Removed “${track.title}” from your library`,
      );
    } catch {
      this.toast.show('Couldn’t update your library. Try again.');
    }
  }

  private setQuery(q: string): void {
    this.query.set(q);
    this.settled.set(q);
    this.onlineQuery.set(q);
  }
}
