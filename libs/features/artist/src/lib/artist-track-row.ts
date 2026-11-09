import {
  ChangeDetectionStrategy,
  Component,
  inject,
  input,
  output,
} from '@angular/core';
import type { Track } from '@open-record/models';
import { ArtistCreditPipe, TrackArtService } from '@open-record/state';
import { OrArtistLinks, OrIconButton, OrSleeve, OrTag } from '@open-record/ui';

/**
 * A record row on the artist screen: sleeve, title, `artist · album` (both
 * link to their screens), an Imported tag when it applies, duration, bookmark
 * and options. The stretched play button sits under the text, so tapping the
 * row plays from it; the current record's title turns coral.
 */
@Component({
  selector: 'or-artist-track-row',
  imports: [ArtistCreditPipe, OrArtistLinks, OrIconButton, OrSleeve, OrTag],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[class.is-current]': 'current()',
  },
  template: `
    <div class="main">
      <!-- Stretched play action; the text and credit links sit above it. -->
      <button
        type="button"
        class="play"
        [attr.aria-label]="
          'Play ' +
          track().title +
          ' by ' +
          track().artist +
          (current() ? ', now playing' : '')
        "
        [attr.aria-current]="current() ? 'true' : null"
        (click)="playTrack.emit()"
      ></button>
      <or-sleeve
        class="sleeve"
        size="thumb"
        [src]="art(track())"
        [label]="track().title"
        [playing]="playing()"
      />
      <span class="text">
        <span class="title">{{ track().title }}</span>
        <span class="sub">
          <or-artist-links
            [credit]="track().artist | artistCredit: track().album"
          />
        </span>
        @if (imported()) {
          <span class="tags"><or-tag ivory>Imported</or-tag></span>
        }
      </span>
    </div>
    <span class="duration">{{ duration() }}</span>
    <or-icon-button
      class="save"
      icon="bookmark"
      [pressed]="saved()"
      [label]="
        (saved() ? 'Remove ' : 'Save ') +
        track().title +
        (saved() ? ' from' : ' to') +
        ' your library'
      "
      (click)="save.emit()"
    />
    <or-icon-button
      class="more"
      icon="more"
      [label]="'Options for ' + track().title"
      (click)="options.emit($event)"
    />
  `,
  styles: `
    :host {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto 44px 44px;
      align-items: center;
      gap: var(--spacing-xs);
      min-block-size: 64px;
      padding: 0 var(--spacing-xxs);
      border-top: 1px solid
        color-mix(in srgb, var(--color-border) 32%, transparent);
      content-visibility: auto;
      contain-intrinsic-size: auto 68px;
    }
    :host(:first-child) {
      border-top: 0;
    }
    .main {
      position: relative;
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      align-items: center;
      gap: 10px;
      min-block-size: 60px;
      min-inline-size: 0;
      padding: var(--spacing-xs);
      background: transparent;
      border: 0;
      border-radius: var(--rounded-md);
      color: inherit;
      font: inherit;
      text-align: left;
    }
    /* Covers the whole row; the text above it lets taps through except links. */
    .play {
      position: absolute;
      inset: 0;
      appearance: none;
      margin: 0;
      padding: 0;
      background: transparent;
      border: 0;
      border-radius: var(--rounded-md);
      cursor: pointer;
    }
    .main > or-sleeve,
    .text {
      pointer-events: none;
    }
    .play:focus-visible {
      outline: 2px solid var(--color-primary);
      outline-offset: 2px;
    }
    .text {
      display: grid;
      min-inline-size: 0;
    }
    .title {
      font-size: 14px;
      font-weight: 600;
      line-height: 1.3;
      overflow-wrap: anywhere;
    }
    :host(.is-current) .title {
      color: var(--color-primary);
    }
    .sub {
      font-size: 13px;
      color: var(--color-muted);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .tags {
      display: flex;
      flex-wrap: wrap;
      gap: var(--spacing-xs);
      margin-top: 3px;
    }
    .duration {
      font-size: 12px;
      color: var(--color-muted);
      font-variant-numeric: tabular-nums;
      text-align: right;
    }
    @media (hover: hover) {
      .main:hover {
        background: color-mix(in srgb, var(--color-text) 5%, transparent);
      }
    }
    @media (min-width: 900px) {
      :host {
        padding: 0 var(--spacing-xs);
        border-top: 0;
        border-radius: var(--rounded-md);
      }
      .main:hover {
        background: transparent;
      }
    }
    @media (min-width: 900px) and (hover: hover) {
      :host(:hover) {
        background: var(--color-surface-raised);
      }
    }
  `,
})
export class ArtistTrackRow {
  private readonly trackArt = inject(TrackArtService);

  readonly track = input.required<Track>();
  readonly duration = input('');
  readonly current = input(false);
  readonly playing = input(false);
  readonly saved = input(false);
  readonly imported = input(false);

  readonly playTrack = output<void>();
  readonly save = output<void>();
  /** The options button's click event (the page reads its button for focus return). */
  readonly options = output<MouseEvent>();

  protected art(track: Track) {
    return this.trackArt.art(track);
  }
}
