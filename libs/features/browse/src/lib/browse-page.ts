import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
} from '@angular/core';
import { Router } from '@angular/router';
import type { Track } from '@open-record/models';
import { LibraryStore, PlayerStore } from '@open-record/state';
import {
  OrButton,
  OrEmptyState,
  OrIcon,
  OrSpinner,
} from '@open-record/ui';
import { OrBinRail } from './bin-rail';
import { OrListeningBooth } from './listening-booth';

interface Bin {
  name: string;
  tracks: readonly Track[];
}

/** Records without a genre are filed here. */
const UNSORTED_BIN = 'Unsorted';
/** The leading rail: the newest records across every bin. */
const FRESH_BIN = 'Fresh in the crates';
const FRESH_LIMIT = 12;

/**
 * Browse: the "listening booth" hero (what is on the turntable) followed by
 * the shop's crates: a "Fresh in the crates" rail, then one horizontal rail
 * per genre bin. Each rail renders its records a page at a time; tapping a
 * record plays it with its whole bin as the queue.
 */
@Component({
  selector: 'or-browse-page',
  imports: [
    OrBinRail,
    OrButton,
    OrEmptyState,
    OrIcon,
    OrListeningBooth,
    OrSpinner,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header class="head">
      <h1 class="display">The listening room</h1>
      <p class="lede">A small collection of old records, ready to play.</p>
    </header>

    <or-listening-booth
      [track]="featured()"
      [loaded]="!!player.current()"
      [playing]="player.isPlaying()"
      [loading]="player.isLoading()"
      [error]="player.error()?.message ?? null"
      [placeholderTitle]="
        status() === 'loading'
          ? 'Dusting off the crates…'
          : 'The turntable is empty'
      "
      (togglePlay)="playFeatured()"
      (openPlayer)="openPlayer()"
    />

    @switch (status()) {
      @case ('loading') {
        <div class="crates-status" role="status">
          <or-spinner [size]="18" />
          <span>Flipping through the crates…</span>
        </div>
      }
      @case ('error') {
        <or-empty-state class="crates-status" role="alert">
          <p class="msg">
            <or-icon name="alert" [size]="18" />
            <span>{{ library.error() ?? 'Could not open the crates.' }}</span>
          </p>
          <or-button size="sm" (click)="retry()">Try again</or-button>
        </or-empty-state>
      }
      @default {
        @for (bin of bins(); track bin.name) {
          <or-bin-rail
            [name]="bin.name"
            [tracks]="bin.tracks"
            [currentId]="player.current()?.id ?? null"
            [playing]="player.isPlaying()"
            (pick)="playRecord($event, bin.tracks)"
          />
        } @empty {
          <or-empty-state class="crates-status">
            The crates are empty. Records you add will be filed here.
          </or-empty-state>
        }
      }
    }
  `,
  styles: `
    :host {
      display: block;
    }
    .head {
      margin: var(--spacing-xxs) 0 14px;
    }
    .display {
      margin: 0 0 5px;
      font-family: var(--type-display-font-family);
      font-size: var(--type-display-font-size);
      font-weight: var(--type-display-font-weight);
      line-height: var(--type-display-line-height);
    }
    .lede {
      margin: 0;
      font-size: var(--type-body-sm-font-size);
      line-height: var(--type-body-sm-line-height);
      color: var(--color-muted);
    }
    @media (min-width: 900px) {
      .display {
        font-size: 40px;
      }
    }
    /* Holds roughly one rail's height so the page doesn't jump on load. */
    .crates-status {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: var(--spacing-sm);
      min-block-size: 200px;
      margin-block-start: 20px;
      color: var(--color-muted);
      font-size: var(--type-body-sm-font-size);
    }
    or-empty-state.crates-status {
      flex-direction: column;
    }
    .msg {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
      margin: 0;
      color: var(--color-primary);
    }
  `,
})
export class BrowsePage {
  protected readonly library = inject(LibraryStore);
  protected readonly player = inject(PlayerStore);
  private readonly router = inject(Router);

  protected readonly status = this.library.status;

  /** What the booth shows: the loaded record, else the first in the crates. */
  protected readonly featured = computed<Track | null>(
    () => this.player.current() ?? this.library.tracks()[0] ?? null,
  );

  /** Genre bins in first-seen order; genre-less records go last. */
  protected readonly bins = computed<Bin[]>(() => {
    const all = this.library.tracks();
    if (!all.length) return [];
    const byGenre = new Map<string, Track[]>();
    for (const t of all) {
      const name = t.genre?.trim() || UNSORTED_BIN;
      const bin = byGenre.get(name);
      if (bin) bin.push(t);
      else byGenre.set(name, [t]);
    }
    const bins = [...byGenre].map(([name, tracks]) => ({ name, tracks }));
    return [
      { name: FRESH_BIN, tracks: all.slice(0, FRESH_LIMIT) },
      ...bins.filter((b) => b.name !== UNSORTED_BIN),
      ...bins.filter((b) => b.name === UNSORTED_BIN),
    ];
  });

  protected playRecord(track: Track, bin: readonly Track[]): void {
    if (this.player.isCurrent(track.id)) {
      void this.player.togglePlay();
      return;
    }
    void this.player.playTrack(track, bin);
  }

  protected playFeatured(): void {
    if (this.player.current()) {
      void this.player.togglePlay();
      return;
    }
    const track = this.featured();
    if (track) void this.player.playTrack(track, this.library.tracks());
  }

  protected openPlayer(): void {
    const track = this.featured();
    if (!this.player.current() && track) {
      void this.player.playTrack(track, this.library.tracks());
    }
    void this.router.navigateByUrl('/now-playing');
  }

  protected retry(): void {
    void this.library.reload();
  }
}
