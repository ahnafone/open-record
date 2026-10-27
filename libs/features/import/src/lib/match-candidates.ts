import { ChangeDetectionStrategy, Component, booleanAttribute, inject, input, output } from '@angular/core';
import type { MetadataCandidate, Track } from '@open-record/models';
import { PreviewPlayerService, type ImportCandidate } from '@open-record/state';
import { OrButton, OrIconButton, OrSleeve, OrSpinner } from '@open-record/ui';

/**
 * Ranked replacement recordings: art, title, artist, length and match score,
 * a preview toggle and "Use this". Shared by the Spotify import review and
 * Fix failed downloads.
 */
@Component({
  selector: 'or-match-candidates',
  imports: [OrButton, OrIconButton, OrSleeve, OrSpinner],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ul class="cands">
      @for (c of candidates(); track c.track.id) {
        @let playing = preview.playingId() === c.track.id;
        @let loading = preview.loadingId() === c.track.id;
        @let checking = pendingId() === c.track.id;
        <li class="cand">
          <or-sleeve size="thumb" [src]="c.track.artUrl" [label]="c.track.title" [playing]="playing" fallbackLabel="No artwork" />
          <span class="text">
            <span class="ctitle" [class.is-current]="playing">{{ c.track.title }}</span>
            <span class="meta">
              {{ c.track.artist }}{{ time(c.track.durationSec) }} ·
              {{ percent(c.score) }}% match{{ c.durationMatch ? '' : ', length differs' }}
            </span>
            @if (c.track.source?.site; as site) {
              <span class="site">{{ site }}</span>
            }
          </span>
          <or-icon-button
            [icon]="loading ? null : playing ? 'pause' : 'play'"
            [label]="'Play preview of ' + c.track.title"
            [pressed]="playing"
            (click)="togglePreview(c.track)"
          >
            @if (loading) {
              <or-spinner [size]="18" label="Loading preview" />
            }
          </or-icon-button>
          <or-button size="sm" [disabled]="disabled() || !!pendingId()" (click)="choose(c.track)">
            @if (checking) {
              <or-spinner [size]="14" label="Checking" />
            }
            Use this
          </or-button>
        </li>
      }
    </ul>
  `,
  styles: `
    :host { display: block; }
    .cands { display: grid; gap: var(--spacing-xs); margin: var(--spacing-sm) 0; padding: 0; list-style: none; }
    .cand { display: flex; align-items: center; gap: var(--spacing-sm); padding: var(--spacing-xs) var(--spacing-xs) var(--spacing-xs) var(--spacing-md);
      background: var(--color-surface); border: 1px solid color-mix(in srgb, var(--color-border) 45%, transparent); border-radius: var(--rounded-md); }
    .text { display: grid; flex: 1; min-inline-size: 0; }
    .ctitle { font-size: 14px; overflow-wrap: anywhere; }
    .ctitle.is-current { color: var(--color-primary); }
    .meta { font-size: 12px; color: var(--color-muted); overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
    .site { font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--color-muted); }
  `,
})
export class MatchCandidates {
  protected readonly preview = inject(PreviewPlayerService);

  readonly candidates = input.required<readonly ImportCandidate[]>();
  /** Another action is running: "Use this" is disabled. */
  readonly disabled = input(false, { transform: booleanAttribute });
  /** Candidate being checked; shows a spinner on its button and disables the rest. */
  readonly pendingId = input<string | null>(null);

  /** The chosen recording (preview is stopped first). */
  readonly use = output<Track>();

  protected time(sec: number | undefined): string {
    if (!sec) return '';
    const s = Math.round(sec);
    return ` · ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  protected percent(score: number): number {
    return Math.round(score * 100);
  }

  protected togglePreview(track: Track): void {
    void this.preview.toggle(track);
  }

  protected choose(track: Track): void {
    void this.preview.stop();
    this.use.emit(track);
  }
}

/**
 * Song-detail suggestions for an imported YouTube song: art, title, artist,
 * album and year, match score and "Use this". No preview: the song's own
 * link stays the audio, only its details change.
 */
@Component({
  selector: 'or-meta-candidates',
  imports: [OrButton, OrSleeve, OrSpinner],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ul class="cands">
      @for (c of candidates(); track c.id) {
        <li class="cand">
          <or-sleeve size="thumb" [src]="c.artUrl" [label]="c.title" fallbackLabel="No artwork" />
          <span class="text">
            <span class="ctitle">{{ c.title }}</span>
            <span class="meta">{{ c.artist }}{{ c.album ? ' · ' + c.album : '' }}{{ c.year ? ' · ' + c.year : '' }}</span>
            <span class="meta">{{ percent(c.score) }}% match{{ c.sources.length ? ' · ' + c.sources.join(', ') : '' }}</span>
          </span>
          <or-button size="sm" [disabled]="disabled()" (click)="use.emit(c)">
            @if (pendingId() === c.id) {
              <or-spinner [size]="14" label="Saving" />
            }
            Use this
          </or-button>
        </li>
      }
    </ul>
  `,
  styles: `
    :host { display: block; }
    .cands { display: grid; gap: var(--spacing-xs); margin: var(--spacing-sm) 0; padding: 0; list-style: none; }
    .cand { display: flex; align-items: center; gap: var(--spacing-sm); padding: var(--spacing-xs) var(--spacing-xs) var(--spacing-xs) var(--spacing-md);
      background: var(--color-surface); border: 1px solid color-mix(in srgb, var(--color-border) 45%, transparent); border-radius: var(--rounded-md); }
    .text { display: grid; flex: 1; min-inline-size: 0; }
    .ctitle { font-size: 14px; overflow-wrap: anywhere; }
    .meta { font-size: 12px; color: var(--color-muted); overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
  `,
})
export class MetaCandidates {
  readonly candidates = input.required<readonly MetadataCandidate[]>();
  /** Another action is running: "Use this" is disabled. */
  readonly disabled = input(false, { transform: booleanAttribute });
  /** Suggestion being applied; shows a spinner on its button. */
  readonly pendingId = input<string | null>(null);

  /** The chosen suggestion. */
  readonly use = output<MetadataCandidate>();

  protected percent(score: number): number {
    return Math.round(score * 100);
  }
}
