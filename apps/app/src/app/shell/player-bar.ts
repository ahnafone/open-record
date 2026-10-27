import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import type { Track } from '@open-record/models';
import { AuthStore, LibraryStore, PlayerStore } from '@open-record/state';
import {
  OrIcon,
  OrIconButton,
  OrSleeve,
  OrSlider,
  OrSpinner,
  OrToast,
} from '@open-record/ui';

/** `m:ss` (or `h:mm:ss`); same as Now Playing's, kept here so the shell does not pull that chunk. */
function formatTime(totalSec: number): string {
  const s = Math.max(0, Math.floor(Number.isFinite(totalSec) ? totalSec : 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/**
 * Desktop player bar (900px+), full width under the content: track, transport
 * with seek bar, then volume and the Now Playing panel toggle. Replaces the
 * mini player and tab bar.
 */
@Component({
  selector: 'or-player-bar',
  imports: [OrIcon, OrIconButton, OrSleeve, OrSlider, OrSpinner],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="track">
      @if (player.current(); as track) {
        <button class="art" type="button" aria-label="Show now playing" (click)="togglePanel.emit()">
          <or-sleeve size="mini" [src]="art()" [lazy]="false" />
          @if (player.isLoading()) {
            <span class="overlay" aria-hidden="true"><or-spinner /></span>
          } @else if (player.error()) {
            <span class="overlay err" aria-hidden="true"><or-icon name="alert" [size]="18" /></span>
          }
        </button>
        <div class="info">
          <span class="title">{{ track.title }}</span>
          <span class="artist">{{ track.artist }}</span>
        </div>
      } @else {
        <span class="idle">Nothing on the turntable</span>
      }
    </div>

    <div class="center">
      <div class="transport">
        <or-icon-button
          icon="shuffle"
          label="Shuffle"
          [iconSize]="20"
          [pressed]="player.shuffle()"
          (click)="player.toggleShuffle()"
        />
        <or-icon-button
          icon="prev"
          label="Previous record"
          [disabled]="!player.current()"
          (click)="player.previous()"
        />
        <or-icon-button
          class="play"
          variant="transport-main"
          [icon]="player.isPlaying() ? 'pause' : 'play'"
          [iconSize]="22"
          [label]="player.isPlaying() ? 'Pause' : 'Play'"
          [disabled]="!player.current()"
          (click)="player.togglePlay()"
        />
        <or-icon-button
          icon="next"
          label="Next record"
          [disabled]="!player.hasNext()"
          (click)="player.next()"
        />
        <or-icon-button
          [icon]="player.repeat() === 'one' ? 'repeat-one' : 'repeat'"
          [iconSize]="20"
          [label]="player.repeat() === 'off' ? 'Repeat off' : player.repeat() === 'one' ? 'Repeat one' : 'Repeat all'"
          [pressed]="player.repeat() !== 'off'"
          (click)="player.cycleRepeat()"
        />
      </div>
      <div class="seek">
        <span class="time">{{ fmt(shown()) }}</span>
        <or-slider
          label="Seek within this record"
          [min]="0"
          [max]="seekMax()"
          [step]="1"
          [largeStep]="10"
          [disabled]="!canSeek()"
          [value]="shown()"
          [valueText]="fmt(shown()) + ' of ' + fmt(seekMax())"
          (valueChange)="scrub.set($event)"
          (committed)="commitSeek($event)"
        />
        <span class="time">{{ fmt(seekMax()) }}</span>
      </div>
    </div>

    <div class="side">
      @if (player.current(); as track) {
        <or-icon-button
          icon="bookmark"
          [label]="saved() ? 'Remove from library' : 'Save to library'"
          [pressed]="saved()"
          (click)="toggleSaved(track)"
        />
      }
      @if (player.canSetVolume) {
        <or-icon-button
          [icon]="player.muted() || player.volume() === 0 ? 'volume-off' : 'volume'"
          [label]="player.muted() ? 'Unmute' : 'Mute'"
          [pressed]="player.muted()"
          (click)="player.toggleMute()"
        />
        <or-slider
          class="volume"
          label="Volume"
          [min]="0"
          [max]="100"
          [step]="1"
          [largeStep]="10"
          [value]="player.muted() ? 0 : volumePct()"
          [valueText]="(player.muted() ? 0 : volumePct()) + '%'"
          (valueChange)="player.setVolume($event / 100)"
        />
      }
      <or-icon-button
        icon="queue"
        label="Now playing and queue"
        [pressed]="panelOpen()"
        (click)="togglePanel.emit()"
      />
    </div>
  `,
  styles: `
    :host {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 2fr) minmax(0, 1fr);
      align-items: center;
      gap: var(--spacing-md);
      min-height: 92px;
      padding: var(--spacing-sm) var(--spacing-md);
      background: var(--color-surface);
      border-top: 1px solid color-mix(in srgb, var(--color-border) 60%, transparent);
    }
    .track {
      display: flex;
      align-items: center;
      gap: var(--spacing-md);
      min-width: 0;
    }
    .art {
      position: relative;
      flex: none;
      inline-size: 56px;
      block-size: 56px;
      padding: 0;
      border: 0;
      background: transparent;
      cursor: pointer;
      border-radius: var(--rounded-sleeve);
    }
    .art or-sleeve {
      inline-size: 100%;
      block-size: 100%;
    }
    .overlay {
      position: absolute;
      inset: 0;
      display: grid;
      place-items: center;
      border-radius: 2px;
      background: color-mix(in srgb, var(--color-vinyl) 72%, transparent);
      color: var(--color-text);
    }
    .overlay.err {
      color: var(--color-primary);
    }
    .info {
      display: grid;
      min-width: 0;
    }
    .title,
    .artist {
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
    }
    .title {
      font-size: 14px;
      font-weight: 600;
      line-height: 1.3;
    }
    .artist,
    .idle {
      font-size: var(--type-meta-font-size);
      color: var(--color-muted);
    }
    .center {
      display: grid;
      justify-items: center;
      min-width: 0;
    }
    .transport {
      display: flex;
      align-items: center;
      gap: var(--spacing-xs);
    }
    .play {
      --or-transport-main-size: 44px;
    }
    .seek {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
      align-items: center;
      gap: var(--spacing-sm);
      inline-size: 100%;
      max-inline-size: 640px;
      margin-top: -6px;
    }
    .time {
      min-width: 40px;
      text-align: center;
      font-size: var(--type-meta-font-size);
      font-variant-numeric: tabular-nums;
      color: var(--color-muted);
    }
    .side {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: var(--spacing-xxs);
    }
    .volume {
      inline-size: 112px;
      flex: none;
    }
  `,
})
export class OrPlayerBar {
  protected readonly player = inject(PlayerStore);
  private readonly library = inject(LibraryStore);
  private readonly auth = inject(AuthStore);
  private readonly toast = inject(OrToast);

  /** Whether the Now Playing panel (or page) is showing. */
  readonly panelOpen = input(false);
  /** Open or close the Now Playing panel. */
  readonly togglePanel = output<void>();

  protected readonly fmt = formatTime;
  /** Slider value while the user drags; null follows playback. */
  protected readonly scrub = signal<number | null>(null);

  protected readonly art = computed(() => {
    const track = this.player.current();
    if (!track) return null;
    if (track.artUrl || !track.coverPath) return track.artUrl;
    return this.library.artUrl(track).catch(() => undefined);
  });
  protected readonly seekMax = computed(() => {
    const d = this.player.duration();
    return d > 0 ? d : (this.player.current()?.durationSec ?? 0);
  });
  protected readonly canSeek = computed(
    () => this.player.duration() > 0 && !this.player.isLoading(),
  );
  protected readonly shown = computed(() => this.scrub() ?? this.player.position());
  protected readonly saved = computed(() => {
    const id = this.player.current()?.id;
    return id ? this.library.isSaved(id) : false;
  });
  protected readonly volumePct = computed(() => Math.round(this.player.volume() * 100));

  protected async commitSeek(sec: number): Promise<void> {
    try {
      await this.player.seek(sec);
    } finally {
      this.scrub.set(null);
    }
  }

  /** Same flow as Now Playing: saving needs an account, removing does not. */
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
