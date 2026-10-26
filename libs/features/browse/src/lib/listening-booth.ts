import {
  ChangeDetectionStrategy,
  Component,
  booleanAttribute,
  computed,
  input,
  output,
} from '@angular/core';
import type { Track } from '@open-record/models';
import { OrButton, OrIcon, OrSleeve, OrSpinner } from '@open-record/ui';
import { injectTrackArt } from './track-art';

/**
 * "Now on the turntable": an ivory sleeve overlapping a grooved disc that
 * spins while playing, the record's serif title and muted subtitle, a
 * reserved status line, and Play record / Open player actions.
 */
@Component({
  selector: 'or-listening-booth',
  imports: [OrButton, OrIcon, OrSleeve, OrSpinner],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <or-sleeve
      size="booth"
      [src]="art(track())"
      [label]="discLabel()"
      [playing]="playing()"
      [lazy]="false"
      [fallbackLabel]="
        track() ? track()!.title + ' sleeve unavailable' : 'No record loaded'
      "
    />
    <div class="info">
      <span class="eyebrow">Now on the turntable</span>
      <h2 class="title">{{ track()?.title ?? placeholderTitle() }}</h2>
      <p class="sub">{{ subtitle() }}</p>
      <p class="status" role="status" aria-live="polite">
        @if (loading()) {
          <or-spinner [size]="16" />
          <span>Cueing the record…</span>
        } @else if (error()) {
          <span class="err">
            <or-icon name="alert" [size]="16" />
            <span>{{ error() }}</span>
          </span>
        } @else if (playing()) {
          <or-icon name="disc" [size]="16" />
          <span>Playing</span>
        } @else if (loaded()) {
          <or-icon name="pause" [size]="16" />
          <span>Paused</span>
        }
      </p>
    </div>
    <div class="actions">
      <or-button
        variant="primary"
        [disabled]="!track()"
        (click)="togglePlay.emit()"
      >
        <or-icon [name]="playing() ? 'pause' : 'play'" [size]="20" />
        {{ playing() ? 'Pause record' : 'Play record' }}
      </or-button>
      <or-button [disabled]="!track()" (click)="openPlayer.emit()">
        Open player
      </or-button>
    </div>
  `,
  styles: `
    :host {
      display: grid;
      gap: 10px;
      padding: var(--spacing-md);
      border-radius: var(--rounded-md);
      background: var(--color-surface);
      border: 1px solid color-mix(in srgb, var(--color-border) 55%, transparent);
    }
    .info {
      display: grid;
      min-width: 0;
      padding: var(--spacing-xxs) var(--spacing-xxs) 0;
    }
    .eyebrow {
      font-size: var(--type-eyebrow-font-size);
      line-height: var(--type-eyebrow-line-height);
      letter-spacing: var(--type-eyebrow-letter-spacing);
      text-transform: uppercase;
      color: var(--color-muted);
    }
    .title {
      margin: 3px 0;
      font-family: var(--type-headline-font-family);
      font-size: var(--type-headline-font-size);
      font-weight: var(--type-headline-font-weight);
      line-height: var(--type-headline-line-height);
      color: var(--color-text);
      overflow-wrap: anywhere;
    }
    .sub {
      margin: 0;
      font-size: var(--type-body-sm-font-size);
      line-height: var(--type-body-sm-line-height);
      color: var(--color-muted);
    }
    /* Reserved so loading/error/playing changes never move the buttons. */
    .status {
      display: flex;
      align-items: center;
      gap: 6px;
      min-block-size: 20px;
      margin: var(--spacing-xs) 0 0;
      font-size: var(--type-meta-font-size);
      line-height: var(--type-meta-line-height);
      letter-spacing: var(--type-meta-letter-spacing);
      color: var(--color-muted);
    }
    .status > span,
    .err > span {
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
    }
    .err {
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
      color: var(--color-primary);
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: var(--spacing-sm);
    }
    /* Desktop: sleeve on the left, details and actions beside it. */
    @media (min-width: 900px) {
      :host {
        grid-template-columns: minmax(0, 260px) minmax(0, 1fr);
        grid-template-rows: 1fr auto auto 1fr;
        align-items: center;
        column-gap: var(--spacing-xl);
        padding: var(--spacing-lg);
      }
      or-sleeve {
        grid-row: 1 / -1;
        align-self: center;
      }
      .info {
        grid-column: 2;
        grid-row: 2;
      }
      .actions {
        grid-column: 2;
        grid-row: 3;
      }
    }
  `,
})
export class OrListeningBooth {
  /** The record on the turntable (current, or the first in the crates). */
  readonly track = input<Track | null>(null);
  /** The track is loaded in the player (vs. just suggested). */
  readonly loaded = input(false, { transform: booleanAttribute });
  readonly playing = input(false, { transform: booleanAttribute });
  readonly loading = input(false, { transform: booleanAttribute });
  readonly error = input<string | null>(null);
  /** Title shown while there is no record (e.g. crates still loading). */
  readonly placeholderTitle = input('The turntable is empty');

  protected readonly art = injectTrackArt();

  readonly togglePlay = output<void>();
  readonly openPlayer = output<void>();

  protected readonly subtitle = computed(() => {
    const t = this.track();
    if (!t) return 'Pick a record from the crates below.';
    return t.year ? `${t.artist} · ${t.year}` : t.artist;
  });

  protected readonly discLabel = computed(() => {
    const y = this.track()?.year;
    return y ? String(y) : '';
  });
}
