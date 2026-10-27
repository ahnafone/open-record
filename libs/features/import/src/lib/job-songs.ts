import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import type { Track } from '@open-record/models';
import { ImportStore, LibraryStore, PlayerStore, formatDuration } from '@open-record/state';
import { OrLoadMore, OrSectionHead, OrSleeve, OrToast, lazyWindow } from '@open-record/ui';

/**
 * Songs the job has finished (matched), newest import first, playable right
 * here so a YouTube import does not need a trip to Import history.
 */
@Component({
  selector: 'or-job-songs',
  imports: [OrLoadMore, OrSectionHead, OrSleeve],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (tracks().length) {
      <or-section-head heading="Added" [level]="3" />
      <ul class="crate">
        @for (t of window.items(); track t.id) {
          @let current = player.isCurrent(t.id);
          <li class="record" [class.is-current]="current">
            <button
              class="record-main"
              type="button"
              [attr.aria-label]="(current ? 'Now playing: ' : 'Play ') + t.title + ' by ' + t.artist"
              [attr.aria-current]="current ? 'true' : null"
              (click)="play(t)"
            >
              <or-sleeve size="thumb" [src]="t.artUrl" [alt]="''" [playing]="current && player.isPlaying()" />
              <span class="info">
                <span class="title">{{ t.title }}</span>
                <span class="artist">{{ t.artist }}@if (t.album) { · {{ t.album }}}</span>
              </span>
              <span class="dur">{{ formatDuration(t.durationSec) }}</span>
            </button>
          </li>
        }
      </ul>
      @if (window.hasMore()) {
        <div class="sentinel" orLoadMore [loadMoreKey]="window.items().length" (loadMore)="window.grow()"></div>
      }
    }
  `,
  styles: `
    :host { display: block; }
    .crate { display: grid; margin: 0; padding: 0; list-style: none; }
    .record { border-top: 1px solid color-mix(in srgb, var(--color-border) 32%, transparent); }
    .record:first-child { border-top: 0; }
    .record-main { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 10px; align-items: center; inline-size: 100%;
      min-block-size: 72px; padding: var(--spacing-xs); color: inherit; font: inherit; text-align: left; background: transparent;
      border: 0; border-radius: var(--rounded-md); cursor: pointer; transition: background var(--duration-fast) var(--ease-standard); }
    .record-main:hover { background: color-mix(in srgb, var(--color-text) 5%, transparent); }
    .record-main:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 2px; }
    .info { display: grid; min-inline-size: 0; }
    .title, .artist { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .title { font-size: 15px; font-weight: 600; }
    .is-current .title { color: var(--color-primary); }
    .artist { font-size: 13px; color: var(--color-muted); }
    .dur { font-size: 12px; color: var(--color-muted); font-variant-numeric: tabular-nums; }
    .sentinel { block-size: 1px; }
    @media (min-width: 900px) { .record-main { min-block-size: 64px; } .record-main:hover { background: var(--color-surface-raised); } }
    @media (prefers-reduced-motion: reduce) { .record-main { transition-duration: 1ms; } }
  `,
})
export class JobSongs {
  private readonly store = inject(ImportStore);
  private readonly library = inject(LibraryStore);
  protected readonly player = inject(PlayerStore);
  private readonly toast = inject(OrToast);
  protected readonly formatDuration = formatDuration;

  /** Matched items' tracks (their match, or the YouTube song itself), newest first. */
  protected readonly tracks = computed(() => {
    const seen = new Set<string>();
    const out: Track[] = [];
    const items = this.store.items();
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (item.state !== 'matched') continue;
      const id = this.store.resolveId(item.key);
      if (seen.has(id)) continue;
      seen.add(id);
      const track = this.library.track(id);
      if (track) out.push(track);
    }
    return out;
  });
  protected readonly window = lazyWindow(this.tracks);

  protected play(track: Track): void {
    this.player.playTrack(track, this.tracks()).catch(() => this.toast.show(`Could not play “${track.title}”.`));
  }
}
