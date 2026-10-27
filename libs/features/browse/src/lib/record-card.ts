import {
  ChangeDetectionStrategy,
  Component,
  booleanAttribute,
  computed,
  inject,
  input,
  output,
} from '@angular/core';
import type { Track } from '@open-record/models';
import { LibraryStore } from '@open-record/state';
import { OrIcon, OrSleeve, OrTag } from '@open-record/ui';
import { injectTrackArt } from './track-art';

/**
 * A record in a crate rail: sleeve with the disc peeking out, title, artist
 * and a fixed-height detail line. The current record gets a coral title, a
 * spinning disc while playing and a "On the turntable" / "Paused" line, so
 * the state never relies on colour alone. Imported records carry an ivory
 * "Imported" tag on the detail line.
 */
@Component({
  selector: 'or-record-card',
  imports: [OrIcon, OrSleeve, OrTag],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[class.is-current]': 'current()',
  },
  template: `
    <button
      class="card"
      type="button"
      [attr.aria-label]="ariaLabel()"
      [attr.aria-current]="current() ? 'true' : null"
      (click)="pick.emit()"
    >
      <or-sleeve
        class="sleeve"
        size="thumb"
        [src]="art(track())"
        [playing]="current() && playing()"
        [fallbackLabel]="track().title + ' sleeve unavailable'"
      />
      <span class="title">{{ track().title }}</span>
      <span class="artist">{{ track().artist }}</span>
      <span class="detail">
        @if (current()) {
          <or-icon [name]="playing() ? 'disc' : 'pause'" [size]="13" />
          {{ playing() ? 'On the turntable' : 'Paused' }}
        } @else {
          @if (imported()) {
            <or-tag ivory>Imported</or-tag>
          }
          <span class="detail-text">{{ detail() }}</span>
        }
      </span>
    </button>
  `,
  styles: `
    :host {
      display: block;
      inline-size: 132px;
    }
    .card {
      appearance: none;
      display: grid;
      align-content: start;
      gap: var(--spacing-xxs);
      inline-size: 100%;
      padding: var(--spacing-xs) var(--spacing-xs) var(--spacing-sm);
      border: 0;
      border-radius: var(--rounded-md);
      background: transparent;
      color: inherit;
      font: inherit;
      text-align: left;
      cursor: pointer;
      transition: transform var(--duration-fast) var(--ease-standard);
    }
    /* Hover only where a pointer can hover: no sticky hover after a tap. */
    @media (hover: hover) {
      .card {
        transition:
          background var(--duration-fast) var(--ease-standard),
          transform var(--duration-fast) var(--ease-standard);
      }
      .card:hover {
        background: color-mix(in srgb, var(--color-text) 5%, transparent);
      }
    }
    .card:active {
      transform: scale(0.97);
    }
    .card:focus-visible {
      outline: 2px solid var(--color-primary);
      outline-offset: 2px;
    }
    /* A 96px sleeve; the disc peeks out to the right like a pulled record. */
    .card .sleeve {
      --s: 96px;
      margin-block-end: var(--spacing-sm);
    }
    @media (min-width: 900px) {
      :host {
        inline-size: 100%;
      }
      .card {
        padding: var(--spacing-sm);
      }
      .card .sleeve {
        --s: 128px;
      }
    }
    @media (hover: hover) and (min-width: 900px) {
      .card:hover {
        background: var(--color-surface-raised);
      }
    }
    .title {
      display: -webkit-box;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 2;
      line-clamp: 2;
      overflow: hidden;
      /* Two reserved lines so cards in a rail line up. */
      min-block-size: calc(2 * 1.3em);
      font-size: var(--type-row-title-font-size);
      font-weight: var(--type-row-title-font-weight);
      line-height: var(--type-row-title-line-height);
      color: var(--color-text);
    }
    :host(.is-current) .title {
      color: var(--color-primary);
    }
    .artist,
    .detail {
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
      color: var(--color-muted);
    }
    .artist {
      font-size: 13px;
      line-height: 1.35;
    }
    .detail {
      display: flex;
      align-items: center;
      gap: var(--spacing-xs);
      /* Fits a 23px tag so imported and catalogue cards line up. */
      min-block-size: 23px;
      font-size: var(--type-meta-font-size);
      line-height: var(--type-meta-line-height);
      letter-spacing: var(--type-meta-letter-spacing);
    }
    .detail-text {
      min-inline-size: 0;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    :host(.is-current) .detail {
      color: var(--color-text);
    }
    @media (prefers-reduced-motion: reduce) {
      .card {
        transition-duration: 1ms;
      }
      .card:active {
        transform: none;
      }
    }
  `,
})
export class OrRecordCard {
  readonly track = input.required<Track>();
  /** This record is the one loaded in the player. */
  readonly current = input(false, { transform: booleanAttribute });
  /** The player is playing (only meaningful while `current`). */
  readonly playing = input(false, { transform: booleanAttribute });
  readonly pick = output<void>();

  private readonly library = inject(LibraryStore);
  protected readonly art = injectTrackArt();
  protected readonly imported = computed(() =>
    this.library.isImported(this.track()),
  );

  protected readonly detail = computed(() => {
    const { year, genre, tags } = this.track();
    // Imported cards spend the room on the tag: year only.
    if (this.imported()) return year ? String(year) : '';
    return [year, tags?.[0] ?? genre].filter(Boolean).join(' · ');
  });

  protected readonly ariaLabel = computed(() => {
    const { title, artist } = this.track();
    const verb = this.current() && this.playing() ? 'Pause' : 'Play';
    return `${verb} ${title} by ${artist}`;
  });
}
