import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
} from '@angular/core';
import type { Track } from '@open-record/models';
import {
  OrLoadMore,
  OrSectionHead,
  RAIL_PAGE_SIZE,
  lazyWindow,
} from '@open-record/ui';
import { OrRecordCard } from './record-card';

/**
 * One crate rail: a section head and a horizontally windowed list of records
 * (a grid on desktop). Renders a page of cards and grows as the end nears;
 * owns its own window so growing one rail does not re-diff the others.
 * `pick` hands back the record; the caller queues the whole bin.
 */
@Component({
  selector: 'or-bin-rail',
  imports: [OrLoadMore, OrRecordCard, OrSectionHead],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    role: 'region',
    '[attr.aria-label]': 'name() + " bin"',
  },
  template: `
    <or-section-head [heading]="name()" />
    <ul class="rail">
      @for (t of window.items(); track t.id) {
        <li>
          <or-record-card
            [track]="t"
            [current]="currentId() === t.id"
            [playing]="playing()"
            (pick)="pick.emit(t)"
          />
        </li>
      }
      @if (window.hasMore()) {
        <li
          class="sentinel"
          orLoadMore
          [loadMoreKey]="window.items().length"
          (loadMore)="window.grow()"
        ></li>
      }
    </ul>
  `,
  styles: `
    /* Skip offscreen rails entirely. content-visibility clips paint to the
       host, so the host carries the edge bleed and the rail keeps its own. */
    :host {
      display: block;
      margin: 0 calc(-1 * var(--spacing-gutter));
      padding: 0 var(--spacing-gutter);
      content-visibility: auto;
      contain-intrinsic-size: auto 240px;
    }
    or-section-head {
      margin-block-start: 20px;
    }
    /* Crate rail: bleeds to the screen edge, re-pads so the next sleeve peeks in. */
    .rail {
      display: flex;
      gap: var(--spacing-sm);
      margin: 0 calc(-1 * var(--spacing-gutter));
      padding: var(--spacing-sm) var(--spacing-gutter) 0;
      list-style: none;
      overflow-x: auto;
      scroll-snap-type: x proximity;
      scroll-padding-inline: var(--spacing-gutter);
      scrollbar-width: none;
    }
    .rail::-webkit-scrollbar {
      display: none;
    }
    .rail > li {
      flex: none;
      scroll-snap-align: start;
    }
    .rail > li:last-child {
      margin-inline-end: var(--spacing-gutter);
    }
    .sentinel {
      inline-size: 1px;
      block-size: 1px;
      align-self: center;
    }
    /* Desktop: crates become a responsive grid instead of a swipe rail. The
       sentinel ends the grid and is picked up by the vertical preload. */
    @media (min-width: 900px) {
      .rail {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(168px, 1fr));
        gap: var(--spacing-md) var(--spacing-sm);
        margin: 0;
        padding: var(--spacing-sm) 0 0;
        overflow: visible;
      }
      .rail > li:last-child {
        margin-inline-end: 0;
      }
    }
  `,
})
export class OrBinRail {
  readonly name = input.required<string>();
  /** The whole bin; only a window of it renders. */
  readonly tracks = input.required<readonly Track[]>();
  /** Id of the record loaded in the player, if any. */
  readonly currentId = input<string | null>(null);
  readonly playing = input(false);
  readonly pick = output<Track>();

  protected readonly window = lazyWindow(
    this.tracks,
    () => this.name(),
    RAIL_PAGE_SIZE,
  );
}
