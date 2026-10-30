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
  AuthStore,
  LibraryStore,
  LOCAL_PROVIDER_ID,
  OfflineStore,
  PlayerStore,
  REMOTE_PROVIDER_ID,
  SessionStore,
  SourceFixService,
} from '@open-record/state';
import {
  OrButton,
  OrEmptyState,
  OrIcon,
  OrIconButton,
  OrLoadMore,
  OrModal,
  OrSectionHead,
  OrSleeve,
  OrSpinner,
  OrTag,
  OrToast,
  lazyWindow,
} from '@open-record/ui';
import { DevicePickerService } from './device-picker';
import { deviceTargetName } from './device-label';
import { OrSeekRow } from './seek-row';
import { formatTime } from './time';
import { injectTrackArt } from './track-art';

interface UpNextRow {
  readonly track: Track;
  /** Index into `PlayerStore.queue()`, for `playAt` and `removeUpcoming`. */
  readonly queueIndex: number;
  /** Added with "Play next". */
  readonly playNext: boolean;
  /** Session entry for this row; null while playback is local. */
  readonly entryId: string | null;
  /** The session's current entry (never a duplicate entry with the same song). */
  readonly current: boolean;
  /** Not playable from this client (missing on the speaker, or a local file). */
  readonly disabled: boolean;
  /** Why the row is disabled; rendered as a tag, never colour alone. */
  readonly note: string;
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
    OrLoadMore,
    OrModal,
    OrSectionHead,
    OrSeekRow,
    OrSleeve,
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
        <button
          type="button"
          class="eyebrow"
          aria-haspopup="dialog"
          [attr.aria-label]="eyebrowLabel()"
          (click)="picker.show()"
        >
          {{ eyebrowText() }}
        </button>
        <span class="sr-only" aria-live="polite">{{ eyebrowText() }}</span>
        <h2 class="title" tabindex="-1" data-now-playing-title>
          {{ track.title }}
        </h2>
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
        <or-seek-row [disabled]="controlsBlocked()" />
      }

      <div class="status" aria-live="polite">
        @if (player.isLoading() && player.retrying()) {
          <span class="status-text"
            ><or-spinner [size]="18" />Reconnecting…</span
          >
        } @else if (player.isLoading()) {
          <span class="status-text"><or-spinner [size]="18" />Loading record…</span>
        } @else if (player.error(); as err) {
          <span class="status-bad"
            ><or-icon name="alert" [size]="18" />{{ err.message }}</span
          >
          @if (playbackActions()) {
            <or-button size="sm" (click)="retryPlayback()">Try again</or-button>
            @if (canFix(track)) {
              <or-button size="sm" (click)="openSourceFix(track)"
                >Fix source</or-button
              >
            }
          }
        } @else if (reconnecting()) {
          <span class="status-text"
            ><or-spinner [size]="18" />Reconnecting to the server…</span
          >
        } @else if (staleTarget()) {
          <span class="status-bad"
            ><or-icon name="alert" [size]="18" />Not responding ·</span
          >
          <or-button size="sm" (click)="playOnThisDevice()" [disabled]="transferring()">
            play on this device?
          </or-button>
        } @else if (session.needsGesture()) {
          <span class="status-text">Paused ·</span>
          <or-button size="sm" (click)="resumeHere()">
            Tap play on this device
          </or-button>
        } @else if (session.mirroring()) {
          <span class="status-text"
            >Playing on {{ targetName() }} · controls are remote</span
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
          [disabled]="controlsBlocked()"
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

      @if (castSeekHint()) {
        <p class="note">Seeking restarts this track on the speaker.</p>
      }

      @if (track.credit) {
        <p class="note">{{ track.credit }}</p>
      }

      <or-section-head heading="Up next" />
      @if (upNext().length) {
        <ol class="queue">
          @for (row of upNextWindow.items(); track row.queueIndex) {
            <li class="row" [class.current]="row.current">
              <button
                type="button"
                class="row-main"
                [disabled]="row.disabled"
                [attr.aria-current]="row.current ? 'true' : null"
                [attr.aria-label]="
                  'Play ' +
                  row.track.title +
                  ' by ' +
                  row.track.artist +
                  (row.playNext ? ', queued to play next' : '') +
                  (row.note ? ', ' + row.note : '')
                "
                (click)="player.playAt(row.queueIndex)"
              >
                <or-sleeve size="thumb" [src]="art(row.track)" />
                <span class="row-txt">
                  <span class="row-title">{{ row.track.title }}</span>
                  <span class="row-artist">{{ row.track.artist }}</span>
                  @if (row.playNext || row.note || row.current) {
                    <span class="row-tags">
                      @if (row.current) {
                        <or-tag ivory>Now playing</or-tag>
                      }
                      @if (row.playNext) {
                        <or-tag>Play next</or-tag>
                      }
                      @if (row.note) {
                        <or-tag>{{ row.note }}</or-tag>
                      }
                    </span>
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
        @if (upNextWindow.hasMore()) {
          <div
            class="sentinel"
            orLoadMore
            [loadMoreKey]="upNextWindow.items().length"
            (loadMore)="upNextWindow.grow()"
          ></div>
        }
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
      position: relative;
      justify-self: start;
      margin: 0;
      padding: 0;
      border: 0;
      background: transparent;
      color: var(--color-muted);
      font: inherit;
      font-size: var(--type-eyebrow-font-size);
      letter-spacing: var(--type-eyebrow-letter-spacing);
      text-transform: uppercase;
      cursor: pointer;
    }
    /* 44px hit area without changing the 11px eyebrow's visual size. */
    .eyebrow::after {
      content: '';
      position: absolute;
      /* 11px type plus 15px above/below clears the 44px target. */
      inset: -15px calc(var(--spacing-sm) * -1);
    }
    .eyebrow:focus-visible {
      outline: 2px solid var(--color-primary);
      outline-offset: 2px;
    }
    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
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
    .time {
      min-width: 36px;
      text-align: center;
      font-size: var(--type-meta-font-size);
      font-variant-numeric: tabular-nums;
      color: var(--color-muted);
    }
    .status {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--spacing-xs) var(--spacing-sm);
      min-block-size: var(--spacing-touch);
      margin: var(--spacing-xxs) 0;
    }
    .status-text,
    .status-bad {
      display: inline-flex;
      align-items: center;
      gap: var(--spacing-sm);
      font-size: var(--type-body-sm-font-size);
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
    .sentinel {
      block-size: 1px;
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
    .row-main:disabled {
      opacity: 0.55;
      cursor: not-allowed;
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
  protected readonly session = inject(SessionStore);
  protected readonly picker = inject(DevicePickerService);
  private readonly library = inject(LibraryStore);
  private readonly offline = inject(OfflineStore);
  private readonly sourceFix = inject(SourceFixService);
  protected readonly auth = inject(AuthStore);
  private readonly toast = inject(OrToast);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  /** Hosted as the desktop side panel: the player bar owns seek and transport. */
  readonly panel = input(false, { transform: booleanAttribute });

  /** Up next row whose options modal is open. */
  protected readonly optionsFor = signal<UpNextRow | null>(null);
  /** A transfer back to this device is in flight (stale-target CTA). */
  protected readonly transferring = signal(false);

  protected readonly fmt = formatTime;
  protected readonly art = injectTrackArt();

  /** Name of the device (or speaker) that owns playback; "This device" locally. */
  protected readonly targetName = computed(() =>
    deviceTargetName(
      this.session.target(),
      this.session.clientId(),
      this.session.devices(),
    ),
  );

  /** One phrasing for the header button and the muted mirroring line. */
  protected readonly playbackWord = computed(() => {
    if (this.session.mirroring() && this.session.targetStale()) {
      return 'Not responding';
    }
    return this.player.isPlaying() ? 'Playing' : 'Paused';
  });

  protected readonly eyebrowText = computed(
    () => `Playing on ${this.targetName()} · ${this.playbackWord()}`,
  );

  protected readonly eyebrowLabel = computed(
    () => `Change playback device. ${this.eyebrowText()}`,
  );

  /** Another device is playing and has stopped responding; offer a transfer. */
  protected readonly staleTarget = computed(
    () => this.session.mirroring() && this.session.targetStale(),
  );

  /** A transcode-only cast stream restarts instead of seeking; say so. */
  protected readonly castSeekHint = computed(
    () =>
      this.session.target()?.kind === 'cast' &&
      this.session.castSeekRestarts(),
  );

  protected readonly reconnecting = computed(
    () => this.session.connection() === 'retrying',
  );

  /** A terminal local playback failure for the current record. */
  protected readonly playbackActions = computed(() => {
    const error = this.player.playbackError();
    const track = this.player.current();
    return !!error && !!track && error.trackId === track.id;
  });

  /**
   * A `local:` entry this client cannot rehydrate. Only while this client is
   * the output: mirroring can still control a remote target's play/pause.
   */
  protected readonly controlsBlocked = computed(() => {
    if (this.session.mirroring()) return false;
    const id = this.player.current()?.id;
    return !!id && this.session.localUnavailable().has(id);
  });

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
  protected readonly upNext = computed<readonly UpNextRow[]>(() => {
    const remote = this.session.ownsPlayback()
      ? this.session.remoteEntries()
      : null;
    const currentEntryId = this.player.currentEntryId();
    const remoteUnavailable = this.session.remoteUnavailable();
    const mirroring = this.session.mirroring();
    const target = this.targetName();

    return this.player.upcomingEntries().map((entry) => {
      const entryId = remote?.[entry.queueIndex]?.entryId ?? null;
      // `local:` files stay on the device that can actually play them.
      const localElsewhere =
        mirroring && entry.track.providerId === LOCAL_PROVIDER_ID;
      const unavailable = !!entryId && remoteUnavailable.has(entryId);
      return {
        ...entry,
        entryId,
        current: !!entryId && entryId === currentEntryId,
        disabled: localElsewhere || unavailable,
        note: localElsewhere
          ? `On ${target}`
          : unavailable
            ? 'Not on speaker'
            : '',
      };
    });
  });

  /** Rendered slice of `upNext` (long queues grow as the end nears). */
  protected readonly upNextWindow = lazyWindow(this.upNext);

  /** Stale-target CTA: move playback back to this tab/device in one tap. */
  protected async playOnThisDevice(): Promise<void> {
    if (this.transferring()) return;
    this.transferring.set(true);
    try {
      const moved = await this.session.transferTo({
        kind: 'device',
        clientId: this.session.clientId(),
        deviceId: this.session.deviceId(),
      });
      if (!moved) {
        this.toast.show(
          this.session.error() ?? 'Could not transfer playback to this device.',
        );
      }
    } finally {
      this.transferring.set(false);
    }
  }

  /** One-tap resume after an autoplay refusal; a refusal is surfaced, never retried. */
  protected async resumeHere(): Promise<void> {
    try {
      await this.player.play();
    } catch {
      this.toast.show('Could not start playback on this device.');
    }
  }

  /** Whether this record has a source link that can be replaced. */
  protected canFix(track: Track): boolean {
    return !!track.source?.url;
  }

  protected openSourceFix(track: Track): void {
    this.sourceFix.open(track);
  }

  /** Retry a local playback failure; the engine reloads the record. */
  protected async retryPlayback(): Promise<void> {
    try {
      await this.player.play();
    } catch {
      this.toast.show('Could not start playback. Try again.');
    }
  }

  /** Options: move a normal-order row into the "Play next" list. */
  protected async playNextFromOptions(): Promise<void> {
    const row = this.optionsFor();
    this.optionsFor.set(null);
    if (!row || row.playNext) return;
    try {
      if (!(await this.player.removeUpcoming(row.queueIndex))) return;
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
  protected async removeFromOptions(): Promise<void> {
    const row = this.optionsFor();
    this.optionsFor.set(null);
    if (!row) return;
    const at = this.upNext().findIndex((r) => r.queueIndex === row.queueIndex);
    if (!(await this.player.removeUpcoming(row.queueIndex))) {
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
