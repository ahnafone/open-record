import {
  ChangeDetectionStrategy,
  Component,
  DOCUMENT,
  DestroyRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import type { Track } from '@open-record/models';
import {
  FailedDownloadsStore,
  PreviewPlayerService,
  SourceFixService,
  isAbort,
  type ImportCandidate,
} from '@open-record/state';
import {
  OrButton,
  OrIcon,
  OrIconButton,
  OrModal,
  OrSleeve,
  OrSpinner,
  OrToast,
} from '@open-record/ui';

/**
 * Shell-level "Fix source" dialog for a record that will not play. Offers
 * checked replacement recordings (with previews) or a pasted YouTube link;
 * nothing changes until a candidate resolves and probes successfully.
 */
@Component({
  selector: 'or-source-fix-dialog',
  imports: [OrButton, OrIcon, OrIconButton, OrModal, OrSleeve, OrSpinner],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <or-modal
      heading="Fix source"
      [open]="!!track()"
      [dismissible]="!checking()"
      (dismissed)="close()"
    >
      @if (track(); as t) {
        <p class="for">
          <span class="for-title">{{ t.title }}</span>
          <span class="artist">{{ t.artist }}</span>
        </p>

        <p class="helper">
          Pick another recording or paste a YouTube or YouTube Music link. We
          check it before changing anything; your title, artist, playlists and
          bookmark stay.
        </p>

        <p class="label">Suggestions</p>
        @if (searching()) {
          <p class="loading" role="status">
            <or-spinner [size]="16" />Searching…
          </p>
        } @else if (suggestions().length) {
          <ul class="candidates">
            @for (c of suggestions(); track c.track.id) {
              @let playing = preview.playingId() === c.track.id;
              @let loading = preview.loadingId() === c.track.id;
              @let pending = checkingId() === c.track.id;
              <li class="candidate">
                <or-sleeve
                  size="thumb"
                  [src]="c.track.artUrl"
                  [label]="c.track.title"
                  [playing]="playing"
                  fallbackLabel="No artwork"
                />
                <span class="text">
                  <span class="ctitle" [class.is-current]="playing">{{
                    c.track.title
                  }}</span>
                  <span class="meta">
                    {{ c.track.artist }}{{ duration(c.track.durationSec) }} ·
                    {{ percent(c.score) }}% match{{
                      c.durationMatch ? '' : ', length differs'
                    }}
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
                <or-button
                  size="sm"
                  [disabled]="checking()"
                  (click)="useCandidate(c.track)"
                >
                  @if (pending) {
                    <or-spinner [size]="14" label="Checking" />
                  }
                  Use this
                </or-button>
              </li>
            }
          </ul>
        } @else {
          <p class="note">
            {{
              searchError() || 'No other versions found. Paste a link instead.'
            }}
          </p>
        }

        <form class="paste" (submit)="submitLink($event)">
          <label class="label" for="or-fix-source-link"
            >YouTube or YouTube Music link</label
          >
          <div class="paste-row">
            <input
              id="or-fix-source-link"
              type="url"
              inputmode="url"
              autocomplete="off"
              placeholder="https://music.youtube.com/watch?v=…"
              aria-describedby="or-fix-source-status"
              [attr.aria-invalid]="error() ? 'true' : null"
              [value]="link()"
              [disabled]="checking()"
              (input)="onInput($event)"
            />
            <or-button
              type="submit"
              size="sm"
              [disabled]="checking() || !link().trim()"
            >
              @if (checkingId() === pasteId) {
                <or-spinner [size]="14" label="Checking link" />
              }
              Use link
            </or-button>
          </div>
        </form>

        <p
          id="or-fix-source-status"
          class="status"
          [class.bad]="!!error()"
          role="status"
        >
          @if (error(); as e) {
            <span class="err"><or-icon name="alert" [size]="14" />{{ e }}</span>
          } @else if (checking()) {
            Checking the link…
          } @else if (preview.error(); as e) {
            {{ e }}
          }
        </p>
      }

      <div orModalActions>
        <or-button block [disabled]="checking()" (click)="close()"
          >Cancel</or-button
        >
      </div>
    </or-modal>
  `,
  styles: `
    :host {
      display: contents;
    }
    .for {
      display: grid;
      margin: 0 0 var(--spacing-sm);
      min-inline-size: 0;
    }
    .for-title {
      font-size: 15px;
      font-weight: 600;
      overflow-wrap: anywhere;
    }
    .artist,
    .note,
    .helper {
      color: var(--color-muted);
    }
    .artist {
      font-size: 13px;
    }
    .helper {
      margin: 0 0 var(--spacing-md);
      font-size: 12px;
      line-height: 1.45;
    }
    .label {
      margin: var(--spacing-sm) 0 var(--spacing-xs);
      font-size: 11px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--color-muted);
    }
    .note {
      margin: 0 0 var(--spacing-sm);
      font-size: 12px;
    }
    .loading {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
      min-block-size: var(--spacing-touch);
      margin: 0;
      font-size: 12px;
      color: var(--color-muted);
    }
    .candidates {
      display: grid;
      gap: var(--spacing-xs);
      margin: 0 0 var(--spacing-sm);
      padding: 0;
      list-style: none;
    }
    .candidate {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--spacing-sm);
      padding: var(--spacing-xs) var(--spacing-xs) var(--spacing-xs)
        var(--spacing-sm);
      background: var(--color-surface);
      border: 1px solid color-mix(in srgb, var(--color-border) 45%, transparent);
      border-radius: var(--rounded-md);
    }
    .text {
      display: grid;
      flex: 1;
      flex-basis: calc(100% - 92px);
      min-inline-size: 0;
    }
    .ctitle {
      font-size: 14px;
      overflow-wrap: anywhere;
    }
    .ctitle.is-current {
      color: var(--color-primary);
    }
    .meta {
      font-size: 12px;
      color: var(--color-muted);
      overflow-wrap: anywhere;
      font-variant-numeric: tabular-nums;
    }
    .site {
      font-size: 11px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--color-muted);
    }
    .paste {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: var(--spacing-xs);
    }
    .paste-row {
      display: flex;
      min-inline-size: 0;
      align-items: center;
      gap: var(--spacing-sm);
    }
    input {
      flex: 1;
      min-inline-size: 0;
      min-block-size: var(--spacing-touch);
      padding: 10px;
      font: inherit;
      color: var(--color-text);
      background: var(--color-background);
      border: 1px solid var(--color-border);
      border-radius: var(--rounded-md);
      outline: none;
      transition: border-color var(--duration-fast) var(--ease-standard);
    }
    input:focus,
    input[aria-invalid='true'] {
      border-color: var(--color-primary);
    }
    input:focus-visible {
      outline: 2px solid var(--color-primary);
      outline-offset: 2px;
    }
    .status {
      margin: var(--spacing-xs) 0 0;
      min-block-size: 36px;
      font-size: 12px;
      line-height: 1.5;
      color: var(--color-muted);
    }
    .status.bad {
      color: var(--color-primary);
    }
    .err {
      display: inline-flex;
      align-items: flex-start;
      gap: 6px;
    }
    .err or-icon {
      flex: none;
      margin-top: 2px;
    }
    @media (prefers-reduced-motion: reduce) {
      input {
        transition-duration: 1ms;
      }
    }
  `,
})
export class OrSourceFixDialog {
  private readonly sourceFix = inject(SourceFixService);
  private readonly store = inject(FailedDownloadsStore);
  private readonly preview = inject(PreviewPlayerService);
  private readonly toast = inject(OrToast);
  private readonly document = inject(DOCUMENT);
  private readonly injector = inject(Injector);

  protected readonly track = this.sourceFix.track;
  protected readonly suggestions = signal<readonly ImportCandidate[]>([]);
  protected readonly searching = signal(false);
  protected readonly searchError = signal('');
  protected readonly link = signal('');
  protected readonly error = signal('');
  /** Candidate id (or `pasteId`) being checked. */
  protected readonly checkingId = signal<string | null>(null);
  protected readonly checking = computed(() => this.checkingId() !== null);
  protected readonly pasteId = '__paste__';

  private abort: AbortController | null = null;

  constructor() {
    effect(() => {
      const track = this.sourceFix.track();
      untracked(() => this.reset());
      if (track) this.search(track);
    });

    inject(DestroyRef).onDestroy(() => {
      this.abort?.abort();
      void this.preview.stop();
    });
  }

  protected close(): void {
    if (this.checking()) return;
    this.sourceFix.close();
  }

  protected onInput(event: Event): void {
    this.link.set((event.target as HTMLInputElement).value);
    this.error.set('');
  }

  protected togglePreview(track: Track): void {
    void this.preview.toggle(track);
  }

  protected useCandidate(candidate: Track): void {
    void this.apply(candidate.id, (signal) =>
      this.store.checkCandidate(candidate, signal),
    );
  }

  protected submitLink(event: Event): void {
    event.preventDefault();
    if (this.checking() || !this.link().trim()) return;
    const link = this.link();
    void this.apply(this.pasteId, (signal) =>
      this.store.checkLink(link, signal),
    );
  }

  protected duration(sec: number | undefined): string {
    if (!sec) return '';
    const s = Math.round(sec);
    return ` · ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  protected percent(score: number): number {
    return Math.round(score * 100);
  }

  /** Abort the previous search, clear the form and stop any preview. */
  private reset(): void {
    this.abort?.abort();
    this.abort = null;
    this.suggestions.set([]);
    this.searching.set(false);
    this.searchError.set('');
    this.link.set('');
    this.error.set('');
    this.checkingId.set(null);
    void this.preview.stop();
  }

  private search(track: Track): void {
    const abort = (this.abort = new AbortController());
    this.searching.set(true);
    this.store
      .suggest(track, abort.signal)
      .then((list) => {
        if (!abort.signal.aborted) this.suggestions.set(list);
      })
      .catch((error: unknown) => {
        if (abort.signal.aborted || isAbort(error)) return;
        this.searchError.set(
          error instanceof Error
            ? error.message
            : 'Could not search. Paste a link instead.',
        );
      })
      .finally(() => {
        if (this.abort === abort) this.searching.set(false);
      });
  }

  /** Check a candidate, then swap the source and start playing it. */
  private async apply(
    id: string,
    check: (signal: AbortSignal) => Promise<Track>,
  ): Promise<void> {
    const track = this.sourceFix.track();
    const abort = this.abort;
    if (!track || !abort || this.checking()) return;
    this.error.set('');
    this.checkingId.set(id);
    void this.preview.stop();
    try {
      const candidate = await check(abort.signal);
      if (abort.signal.aborted) return;
      const result = await this.store.replaceForPlayback(track.id, candidate);
      this.sourceFix.close();
      this.toast.show(
        result.current
          ? `Source changed. Playing “${result.track.title}”.`
          : 'Source changed, but that record is no longer current.',
      );
      this.focusTitle();
    } catch (error) {
      if (abort.signal.aborted || isAbort(error)) return;
      this.error.set(
        error instanceof Error
          ? error.message
          : 'Something went wrong. Try again.',
      );
    } finally {
      if (this.abort === abort) this.checkingId.set(null);
    }
  }

  /** Return focus to the Now Playing title after the modal closes. */
  private focusTitle(): void {
    afterNextRender(
      () => {
        const page = this.document.querySelector<HTMLElement>(
          'or-now-playing-page',
        );
        const title = page?.querySelector<HTMLElement>(
          '[data-now-playing-title]',
        );
        if (title) {
          title.focus();
          return;
        }
        const fallback =
          page?.querySelector<HTMLElement>(
            '.transport button[aria-label="Play"], .transport button[aria-label="Pause"], .status button',
          ) ??
          this.document.querySelector<HTMLElement>(
            'or-player-bar .play button, or-mini-player button[aria-label="Pause"], or-mini-player button[aria-label="Play"]',
          );
        fallback?.focus();
      },
      { injector: this.injector },
    );
  }
}
