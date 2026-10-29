import {
  ChangeDetectionStrategy,
  Component,
  booleanAttribute,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { PlayerStore } from '@open-record/state';
import { OrSlider } from '@open-record/ui';
import { formatTime } from './time';

/**
 * Now Playing seek row: elapsed time, the seek slider and the length. Its own
 * component so position ticks re-render only this row, not the page (and its
 * up-next list).
 */
@Component({
  selector: 'or-seek-row',
  imports: [OrSlider],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
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
  `,
  styles: `
    :host {
      display: block;
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
  `,
})
export class OrSeekRow {
  private readonly player = inject(PlayerStore);

  /** Disable scrubbing (e.g. this client cannot play the current local entry). */
  readonly disabled = input(false, { transform: booleanAttribute });

  /** Slider value while the user drags; null follows playback. */
  protected readonly scrub = signal<number | null>(null);

  protected readonly fmt = formatTime;

  protected readonly seekMax = computed(() => {
    const d = this.player.duration();
    return d > 0 ? d : (this.player.current()?.durationSec ?? 0);
  });

  protected readonly canSeek = computed(
    () =>
      !this.disabled() &&
      this.player.duration() > 0 &&
      !this.player.isLoading(),
  );

  protected readonly shownPosition = computed(
    () => this.scrub() ?? this.player.position(),
  );

  protected async commitSeek(sec: number): Promise<void> {
    try {
      await this.player.seek(sec);
    } finally {
      this.scrub.set(null);
    }
  }
}
