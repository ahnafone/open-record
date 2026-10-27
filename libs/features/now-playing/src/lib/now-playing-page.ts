import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  booleanAttribute,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import type { Track } from '@open-record/models';
import {
  LibraryStore,
  OfflineStore,
  PlayerStore,
  REMOTE_PROVIDER_ID,
  AuthStore,
} from '@open-record/state';
import {
  OrButton,
  OrEmptyState,
  OrIcon,
  OrIconButton,
  OrModal,
  OrSectionHead,
  OrSleeve,
  OrSlider,
  OrSpinner,
  OrTag,
  OrToast,
} from '@open-record/ui';
import { injectTrackArt } from './track-art';

interface UpNextRow {
  readonly track: Track;
  /** Index into `PlayerStore.queue()`, for `playAt` and `removeUpcoming`. */
  readonly queueIndex: number;
  /** Added with "Play next". */
  readonly playNext: boolean;
}

/** `m:ss` (or `h:mm:ss`) for seek times. */
export function formatTime(totalSec: number): string {
  const s = Math.max(0, Math.floor(Number.isFinite(totalSec) ? totalSec : 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/**
 * Now Playing: large sleeve over a disc that spins while playing, title,
 * artist, album, tags (imported, licence, year, genre), a reserved status
 * line, the seek bar, the transport row, the track credit and the up-next
 * queue. The shell's top bar already carries the screen's h1. As the desktop
 * side panel (`panel`), the seek and transport rows are left to the player bar.
 */
@Component({
  selector: 'or-now-playing-page',
  imports: [
    RouterLink,
    OrButton,
    OrEmptyState,
    OrIcon,
    OrIconButton,
    OrModal,
    OrSectionHead,
    OrSleeve,
    OrSlider,
    OrSpinner,
    OrTag,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (player.current(); as track) {
      <div class="np">
      <div class="np-art">
      <or-sleeve
        class="stage"
        size="large"
        [src]="art(track)"
        [alt]="'Sleeve of ' + track.title"
        [label]="track.year ? '' + track.year : ''"
        [playing]="player.isPlaying()"
        [lazy]="false"
      />
      </div>
      <div class="np-body">
      <div class="meta">
        <span class="eyebrow">{{
          player.isPlaying() ? 'On the turntable' : 'Paused'
        }}</span>
        <h2 class="title">{{ track.title }}</h2>
        <p class="artist">{{ track.artist }}</p>
        @if (albumLine(track); as album) {
          <p class="album">{{ album }}</p>
        }
        <div class="tags">
          @if (isImported(track)) {
            <or-tag ivory>Imported</or-tag>
          }
          @if (isStreamingOnly(track)) {
            <or-tag>Streaming only</or-tag>
          }
          @if (track.license) {
            <or-tag ivory>{{ track.license }}</or-tag>
          }
          @if (track.year) {
            <or-tag>{{ track.year }}</or-tag>
          }
          @if (track.genre) {
            <or-tag>{{ track.genre }}</or-tag>
          }
          @for (tag of track.tags ?? []; track tag) {
            @if (tag !== track.genre) {
              <or-tag>{{ tag }}</or-tag>
            }
          }
        </div>
      </div>

      @if (!panel()) {
      <div class="seek">
        <span class="time">{{ fmt(shownPosition()) }}</span>
        <or-slider
          label="Seek within this record"
          [min]="0"
          [max]="seekMax()"
          [step]="1"
          [largeStep]="10"
          [disabled]="!canSeek()"
          [value]="shownPosition()"
          (valueChange)="scrub.set($event)"
          (committed)="commitSeek($event)"
          [valueText]="fmt(shownPosition()) + ' of ' + fmt(seekMax())"
        />
        <span class="time">{{ fmt(seekMax()) }}</span>
      </div>
      }

      <div class="status" aria-live="polite">
        @if (player.isLoading()) {
          <span class="status-load"><or-spinner [size]="18" />Loading record…</span>
        } @else if (player.error(); as err) {
          <span class="status-bad"
            ><or-icon name="alert" [size]="18" />{{ err.message }}</span
          >
        }
      </div>

      @if (!panel()) {
      <div class="transport">
        <or-icon-button
          variant="transport"
          icon="shuffle"
          label="Shuffle"
          [pressed]="player.shuffle()"
          (click)="player.toggleShuffle()"
        />
        <or-icon-button
          variant="transport"
          icon="prev"
          label="Previous record"
          (click)="player.previous()"
        />
        <or-icon-button
          variant="transport-main"
          [icon]="player.isPlaying() ? 'pause' : 'play'"
          [iconSize]="28"
          [label]="player.isPlaying() ? 'Pause' : 'Play'"
          (click)="player.togglePlay()"
        />
        <or-icon-button
          variant="transport"
          icon="next"
          label="Next record"
          [disabled]="!player.hasNext()"
          (click)="player.next()"
        />
        <or-icon-button
          variant="transport"
          [icon]="player.repeat() === 'one' ? 'repeat-one' : 'repeat'"
          [label]="repeatLabel()"
          [pressed]="player.repeat() !== 'off'"
          (click)="player.cycleRepeat()"
        >
        </or-icon-button>
        <or-icon-button
          variant="transport"
          icon="bookmark"
          [label]="
            saved() ? 'Remove from your library' : 'Save to your library'
          "
          [pressed]="saved()"
          (click)="toggleSaved(track)"
        />
      </div>
      }

      @if (track.credit) {
        <p class="note">{{ track.credit }}</p>
      }

      <or-section-head heading="Up next" />
      @if (upNext().length) {
        <ol class="queue">
          @for (row of upNext(); track row.queueIndex) {
            <li class="row">
              <button
                type="button"
                class="row-main"
                [attr.aria-label]="
                  'Play ' +
                  row.track.title +
                  ' by ' +
                  row.track.artist +
                  (row.playNext ? ', queued to play next' : '')
                "
                (click)="player.playAt(row.queueIndex)"
              >
                <or-sleeve size="thumb" [src]="art(row.track)" />
                <span class="row-txt">
                  <span class="row-title">{{ row.track.title }}</span>
                  <span class="row-artist">{{ row.track.artist }}</span>
                  @if (row.playNext) {
                    <span class="row-tags"><or-tag>Play next</or-tag></span>
                  }
                </span>
                @if (row.track.durationSec) {
                  <span class="time">{{ fmt(row.track.durationSec) }}</span>
                }
              </button>
              <or-icon-button
                icon="more"
                data-upnext-options
                [label]="'Options for ' + row.track.title"
                (click)="optionsFor.set(row)"
              />
            </li>
          }
        </ol>
      } @else {
        <or-empty-state>Nothing else is queued after this record.</or-empty-state>
      }

      <or-modal
        [open]="!!optionsFor()"
        [heading]="optionsFor()?.track?.title ?? 'Record'"
        (dismissed)="optionsFor.set(null)"
      >
        <div orModalActions>
          @if (optionsFor()?.playNext === false) {
            <or-button block (click)="playNextFromOptions()">Play next</or-button>
          }
          <or-button block variant="danger" (click)="removeFromOptions()">
            Remove from queue
          </or-button>
          <or-button block (click)="optionsFor.set(null)">Close</or-button>
        </div>
      </or-modal>
      </div>
      </div>
    } @else {
      <or-empty-state class="nothing">
        <p>Nothing is playing yet. Pick a record from the crates.</p>
        <a class="link-btn" routerLink="/browse">Browse the crates</a>
      </or-empty-state>
    }
  `,
  styles: `
    :host {
      display: block;
    }
    /* Phone and the desktop side panel: one column (wrappers are transparent). */
    .np,
    .np-art,
    .np-body {
      display: contents;
    }
    /* Desktop /now-playing route: sleeve left (sticky), details and queue right. */
    @media (min-width: 900px) {
      :host {
        container-type: inline-size;
      }
      @container (min-width: 640px) {
        .np {
          display: grid;
          grid-template-columns: minmax(0, 5fr) minmax(0, 6fr);
          gap: var(--spacing-xl);
          align-items: start;
          max-inline-size: 1100px;
          margin-inline: auto;
        }
        .np-art {
          display: block;
          position: sticky;
          top: 0;
        }
        .np-body {
          display: block;
        }
      }
    }
    .stage {
      margin: 6px 0 var(--spacing-lg);
    }
    .meta {
      display: grid;
      gap: var(--spacing-xxs);
      margin-bottom: 10px;
    }
    .eyebrow {
      font-size: var(--type-eyebrow-font-size);
      letter-spacing: var(--type-eyebrow-letter-spacing);
      text-transform: uppercase;
      color: var(--color-muted);
    }
    .title {
      margin: 0;
      font-family: var(--type-headline-font-family);
      font-size: var(--type-headline-font-size);
      font-weight: var(--type-headline-font-weight);
      line-height: var(--type-headline-line-height);
      /* Text colour: the coral play button is this view's one coral element. */
      color: var(--color-text);
      overflow-wrap: anywhere;
    }
    .artist {
      margin: var(--spacing-xs) 0 6px;
      font-size: 15px;
      color: var(--color-muted);
    }
    .album {
      margin: -2px 0 6px;
      font-size: var(--type-body-sm-font-size);
      color: var(--color-muted);
      overflow-wrap: anywhere;
    }
    .tags {
      display: flex;
      flex-wrap: wrap;
      gap: var(--spacing-xs);
    }
    .seek {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
      align-items: center;
      gap: var(--spacing-sm);
    }
    .time {
      min-width: 36px;
      text-align: center;
      font-size: var(--type-meta-font-size);
      font-variant-numeric: tabular-nums;
      color: var(--color-muted);
    }
    .status {
      min-height: 24px;
      margin: var(--spacing-xxs) 0;
    }
    .status-load,
    .status-bad {
      display: inline-flex;
      align-items: center;
      gap: var(--spacing-sm);
      font-size: var(--type-body-sm-font-size);
    }
    .status-load {
      color: var(--color-muted);
    }
    .status-bad {
      color: var(--color-primary);
    }
    .transport {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--spacing-xs);
      margin: 10px 0 var(--spacing-xs);
    }
    .note {
      margin: 14px 0 0;
      font-size: var(--type-meta-font-size);
      color: var(--color-muted);
    }
    .note + .note {
      margin-block-start: var(--spacing-xxs);
    }
    .queue {
      list-style: none;
      margin: 0;
      padding: 0;
      display: grid;
    }
    .row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: center;
      gap: var(--spacing-xxs);
    }
    .row-tags {
      display: flex;
      margin-top: var(--spacing-xxs);
    }
    .row + .row {
      border-top: 1px solid
        color-mix(in srgb, var(--color-border) 32%, transparent);
    }
    .row-main {
      appearance: none;
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
      gap: 10px;
      align-items: center;
      inline-size: 100%;
      min-height: 72px;
      padding: var(--spacing-xs);
      border: 0;
      border-radius: var(--rounded-md);
      background: transparent;
      color: inherit;
      font: inherit;
      text-align: left;
      cursor: pointer;
      transition: background var(--duration-fast) var(--ease-standard);
    }
    .row-main:hover {
      background: color-mix(in srgb, var(--color-text) 5%, transparent);
    }
    .row-main:focus-visible,
    .link-btn:focus-visible {
      outline: 2px solid var(--color-primary);
      outline-offset: 2px;
    }
    .row-txt {
      display: grid;
      min-width: 0;
    }
    .row-title,
    .row-artist {
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
    }
    .row-title {
      font-size: 15px;
      font-weight: 600;
      line-height: 1.3;
    }
    .row-artist {
      font-size: 13px;
      color: var(--color-muted);
    }
    .nothing p {
      margin: 0 0 var(--spacing-md);
    }
    .link-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: var(--spacing-touch);
      padding: 0 var(--spacing-lg);
      border-radius: var(--rounded-md);
      background: var(--color-surface);
      border: 1px solid color-mix(in srgb, var(--color-border) 75%, transparent);
      color: var(--color-text);
      font-size: var(--type-button-font-size);
      text-decoration: none;
      transition:
        background var(--duration-fast) var(--ease-standard),
        transform var(--duration-fast) var(--ease-standard);
    }
    .link-btn:hover {
      background: var(--color-surface-raised);
    }
    .link-btn:active {
      transform: scale(0.97);
    }
    @media (prefers-reduced-motion: reduce) {
      .row-main,
      .link-btn {
        transition-duration: 1ms;
      }
      .link-btn:active {
        transform: none;
      }
    }
  `,
})
export class NowPlayingPage {
  protected readonly player = inject(PlayerStore);
  private readonly library = inject(LibraryStore);
  private readonly offline = inject(OfflineStore);
  protected readonly auth = inject(AuthStore);
  private readonly toast = inject(OrToast);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  /** Hosted as the desktop side panel: the player bar owns seek and transport. */
  readonly panel = input(false, { transform: booleanAttribute });

  /** Up next row whose options modal is open. */
  protected readonly optionsFor = signal<UpNextRow | null>(null);

  /** Slider value while the user drags; null follows playback. */
  protected readonly scrub = signal<number | null>(null);

  protected readonly fmt = formatTime;
  protected readonly art = injectTrackArt();

  protected readonly seekMax = computed(() => {
    const d = this.player.duration();
    return d > 0 ? d : (this.player.current()?.durationSec ?? 0);
  });

  protected readonly canSeek = computed(
    () => this.player.duration() > 0 && !this.player.isLoading(),
  );

  protected readonly shownPosition = computed(
    () => this.scrub() ?? this.player.position(),
  );

  protected readonly saved = computed(() => {
    const id = this.player.current()?.id;
    return id ? this.library.isSaved(id) : false;
  });

  protected readonly repeatLabel = computed(() => {
    switch (this.player.repeat()) {
      case 'all':
        return 'Repeat all (tap for repeat one)';
      case 'one':
        return 'Repeat one (tap to turn off)';
      default:
        return 'Repeat off (tap to repeat all)';
    }
  });

  /** Upcoming tracks ("Play next" picks first) with their queue indices. */
  protected readonly upNext = computed<readonly UpNextRow[]>(() =>
    this.player.upcomingEntries(),
  );

  /** Options: move a normal-order row into the "Play next" list. */
  protected async playNextFromOptions(): Promise<void> {
    const row = this.optionsFor();
    this.optionsFor.set(null);
    if (!row || row.playNext) return;
    try {
      if (!this.player.removeUpcoming(row.queueIndex)) return;
      await this.player.playNext([row.track]);
      this.toast.show(`“${row.track.title}” plays next`);
      // The row moved (and was re-rendered): focus its options button.
      const at = this.upNext().filter((r) => r.playNext).length - 1;
      this.focusOptions(at);
    } catch {
      this.toast.show('Could not queue that record. Try again.');
    }
  }

  /** Options: drop the row from the queue (by queue index, not id). */
  protected removeFromOptions(): void {
    const row = this.optionsFor();
    this.optionsFor.set(null);
    if (!row) return;
    const at = this.upNext().findIndex((r) => r.queueIndex === row.queueIndex);
    if (!this.player.removeUpcoming(row.queueIndex)) {
      this.toast.show('Could not remove that record');
      return;
    }
    this.toast.show(`Removed “${row.track.title}” from the queue`);
    // The row (and its options button) is gone; move focus somewhere sane.
    this.focusOptions(at);
  }

  /** After render, focus the `index`-th row's options (clamped), else the list. */
  private focusOptions(index: number): void {
    afterNextRender(
      () => {
        const root = this.host.nativeElement;
        const buttons = root.querySelectorAll<HTMLElement>(
          '[data-upnext-options] button',
        );
        const button = buttons[Math.min(Math.max(index, 0), buttons.length - 1)];
        if (button) {
          button.focus();
          return;
        }
        // Queue emptied: focus the empty-state note so focus is not lost.
        const empty = root.querySelector<HTMLElement>('or-empty-state');
        empty?.setAttribute('tabindex', '-1');
        empty?.focus();
      },
      { injector: this.injector },
    );
  }

  protected isImported(track: Track): boolean {
    return this.library.isImported(track);
  }

  /** A server track that is not saved on this device (it streams). */
  protected isStreamingOnly(track: Track): boolean {
    return (
      track.providerId === REMOTE_PROVIDER_ID &&
      this.offline.status(track.id) === undefined
    );
  }

  /** Album title for the line under the artist (year and genre are tags). */
  protected albumLine(track: Track): string {
    return track.album?.trim() ?? '';
  }

  protected async commitSeek(sec: number): Promise<void> {
    try {
      await this.player.seek(sec);
    } finally {
      this.scrub.set(null);
    }
  }

  protected async toggleSaved(track: Track): Promise<void> {
    if (!this.library.isSaved(track.id) && !this.auth.requireAccount()) return;
    try {
      const nowSaved = await this.library.toggleSaved(track.id);
      this.toast.show(
        nowSaved
          ? `Saved “${track.title}” to your library`
          : `Removed “${track.title}” from your library`,
      );
    } catch {
      this.toast.show('Could not update your library');
    }
  }
}
