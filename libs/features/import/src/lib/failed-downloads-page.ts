import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import type { Track } from '@open-record/models';
import {
  AGE_RESTRICTED_REASON,
  FailedDownloadsStore,
  LibraryStore,
  OfflineStore,
  PreviewPlayerService,
  formatDuration,
  isAbort,
  sourceLabel,
  type ImportCandidate,
} from '@open-record/state';
import {
  OrButton,
  OrEmptyState,
  OrIcon,
  OrModal,
  OrSleeve,
  OrSpinner,
  OrTag,
  OrToast,
} from '@open-record/ui';
import { MatchCandidates } from './match-candidates';

/**
 * Fix failed downloads: songs that could not be saved, each with a Retry that
 * re-queues the same source and a "Fix link" dialog that offers checked
 * replacement recordings or a pasted YouTube link. "Retry all" retries every
 * failed song in turn.
 */
@Component({
  selector: 'or-failed-downloads-page',
  imports: [MatchCandidates, OrButton, OrEmptyState, OrIcon, OrModal, OrSleeve, OrSpinner, OrTag],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <p class="lede">
      These songs couldn’t be downloaded. Retry to download the same link again, or pick another version or paste a
      YouTube link; a replacement is checked before anything changes, and your title, artist, playlists and bookmark
      stay as they are.
    </p>
    @if (!loaded()) {
      <p class="loading" role="status"><or-spinner [size]="16" />Loading…</p>
    } @else if (store.listed().length) {
      @if (ageHint()) {
        <p class="note age-hint">
          Some songs are age-restricted. Add or refresh signed-in YouTube cookies on your download server (see its
          README), then press Retry to try again.
        </p>
      }
      @if (store.tracks().length || retryingAll()) {
        <div class="toolbar">
          <or-button size="sm" (click)="retryAll()">
            @if (retryingAll()) {
              <or-spinner [size]="14" />Retrying…
            } @else {
              Retry all
            }
          </or-button>
        </div>
      }
      <ul class="crate">
        @for (t of store.listed(); track t.id) {
          @let source = sourceLabel(t.source?.site);
          @let retrying = store.isRetrying(t.id);
          <li class="record">
            <span class="record-main">
              <or-sleeve size="thumb" [src]="t.artUrl" [alt]="''" />
              <span class="info">
                <span class="title">{{ t.title }}</span>
                <span class="artist">{{ t.artist }}@if (t.album) { · {{ t.album }}}</span>
                <span class="detail">
                  @if (source) {
                    <or-tag>{{ source }}</or-tag>
                  }
                  @if (retrying) {
                    <or-tag role="status"><or-spinner [size]="12" />Retrying…</or-tag>
                  } @else {
                    <or-tag class="tag-failed" icon="alert" [attr.title]="offline.error(t.id)">{{ store.reason(t.id) }}</or-tag>
                  }
                  @if (formatDuration(t.durationSec); as d) {
                    <span class="dur">{{ d }}</span>
                  }
                </span>
              </span>
            </span>
            <span class="actions">
              <or-button
                size="sm"
                [ariaLabel]="(retrying ? 'Retrying download of ' : 'Retry download of ') + t.title"
                (click)="retry(t)"
              >
                @if (retrying) {
                  <or-spinner [size]="14" />Retrying…
                } @else {
                  Retry
                }
              </or-button>
              <or-button size="sm" [ariaLabel]="'Fix link for ' + t.title" (click)="openFix(t)">
                <or-icon name="link" [size]="16" />Fix link
              </or-button>
            </span>
          </li>
        }
      </ul>
    } @else {
      <or-empty-state>Nothing to fix. Every song that should be on this device downloaded.</or-empty-state>
    }

    <or-modal heading="Fix link" [open]="!!fixing()" (openChange)="$event || closeFix()">
      @if (fixing(); as t) {
        <p class="for">
          <span class="for-title">{{ t.title }}</span>
          <span class="artist">{{ t.artist }}</span>
        </p>

        <p class="label">Suggestions</p>
        @if (searching()) {
          <p class="loading" role="status"><or-spinner [size]="16" />Searching…</p>
        } @else if (suggestions().length) {
          <or-match-candidates
            [candidates]="suggestions()"
            [disabled]="checking()"
            [pendingId]="checkingId()"
            (use)="useCandidate($event)"
          />
        } @else {
          <p class="note">{{ searchError() || 'No other versions found. Paste a link instead.' }}</p>
        }

        <form class="paste" (submit)="submitLink($event)">
          <label class="label" for="or-fix-link">YouTube or YouTube Music link</label>
          <div class="paste-row">
            <input
              id="or-fix-link"
              type="url"
              inputmode="url"
              autocomplete="off"
              placeholder="https://music.youtube.com/watch?v=…"
              aria-describedby="or-fix-status"
              [attr.aria-invalid]="error() ? 'true' : null"
              [value]="link()"
              [disabled]="checking()"
              (input)="onInput($event)"
            />
            <or-button type="submit" size="sm" [disabled]="checking() || !link().trim()">
              @if (checkingId() === pasteId) {
                <or-spinner [size]="14" label="Checking link" />
              }
              Use link
            </or-button>
          </div>
        </form>
        <p id="or-fix-status" class="status" [class.bad]="!!error()" role="status">
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
        <or-button block (click)="closeFix()">Cancel</or-button>
      </div>
    </or-modal>
  `,
  styles: `
    :host { display: block; max-inline-size: 800px; }
    .lede { margin: 0 0 var(--spacing-md); font-size: 13px; line-height: 1.45; color: var(--color-muted); }
    .loading { display: flex; align-items: center; gap: var(--spacing-sm); min-block-size: var(--spacing-touch); margin: 0;
      font-size: 12px; color: var(--color-muted); }
    .crate { display: grid; margin: 0; padding: 0; list-style: none; }
    .record { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: var(--spacing-sm);
      padding: var(--spacing-xxs) 0; border-top: 1px solid color-mix(in srgb, var(--color-border) 32%, transparent); }
    .record:first-child { border-top: 0; }
    .record-main { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 10px; align-items: center;
      min-block-size: 72px; min-inline-size: 0; padding: var(--spacing-xs); }
    .info { display: grid; min-inline-size: 0; }
    .title, .artist { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .title { font-size: var(--type-row-title-font-size); font-weight: var(--type-row-title-font-weight);
      line-height: var(--type-row-title-line-height); }
    .artist { font-size: 13px; color: var(--color-muted); }
    .detail { display: flex; flex-wrap: wrap; align-items: center; gap: var(--spacing-xxs) var(--spacing-xs); margin-top: 3px;
      min-block-size: 23px; font-size: var(--type-meta-font-size); color: var(--color-muted); }
    or-tag.tag-failed { color: var(--color-primary); border-color: color-mix(in srgb, var(--color-primary) 55%, transparent); }
    .actions { display: flex; flex-wrap: wrap; gap: var(--spacing-xs); justify-content: flex-end; }
    .toolbar { display: flex; justify-content: flex-end; margin-block-end: var(--spacing-sm); }
    .dur { font-variant-numeric: tabular-nums; }
    .for { display: grid; margin: 0; min-inline-size: 0; }
    .for-title { font-size: 15px; font-weight: 600; overflow-wrap: anywhere; }
    .label { margin: 0; font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--color-muted); }
    .note { margin: 0; font-size: 12px; color: var(--color-muted); }
    .age-hint { margin-bottom: var(--spacing-md); }
    .paste { display: grid; gap: var(--spacing-xs); }
    .paste-row { display: flex; align-items: center; gap: var(--spacing-sm); }
    input { flex: 1; min-inline-size: 0; min-block-size: var(--spacing-touch); padding: 10px; font: inherit; color: var(--color-text);
      background: var(--color-background); border: 1px solid var(--color-border); border-radius: var(--rounded-md); outline: none;
      transition: border-color var(--duration-fast) var(--ease-standard); }
    input:focus, input[aria-invalid='true'] { border-color: var(--color-primary); }
    input:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 2px; }
    .status { margin: 0; min-block-size: 36px; font-size: 12px; line-height: 1.5; color: var(--color-muted); }
    .status.bad { color: var(--color-primary); }
    .err { display: inline-flex; align-items: flex-start; gap: 6px; }
    .err or-icon { flex: none; margin-top: 2px; }
    @media (min-width: 900px) {
      .record, .record:first-child { border-top: 0; border-bottom: 1px solid color-mix(in srgb, var(--color-border) 32%, transparent); }
      .record-main { min-block-size: 64px; }
    }
    @media (max-width: 600px) {
      .record { grid-template-columns: minmax(0, 1fr); }
      .actions { padding-inline: var(--spacing-xs); }
      .toolbar { justify-content: flex-start; }
    }
    @media (prefers-reduced-motion: reduce) {
      input { transition-duration: 1ms; }
    }
  `,
})
export class FailedDownloadsPage {
  protected readonly store = inject(FailedDownloadsStore);
  protected readonly offline = inject(OfflineStore);
  protected readonly preview = inject(PreviewPlayerService);
  private readonly library = inject(LibraryStore);
  private readonly toast = inject(OrToast);

  protected readonly sourceLabel = sourceLabel;
  protected readonly formatDuration = formatDuration;
  protected readonly pasteId = '__paste__';

  protected readonly loaded = signal(false);
  /** True while "Retry all" is working through the failed songs. */
  protected readonly retryingAll = signal(false);
  /** True when any listed song failed because YouTube asked for an age check. */
  protected readonly ageHint = computed(() =>
    this.store.tracks().some((t) => this.store.reason(t.id) === AGE_RESTRICTED_REASON),
  );
  protected readonly fixing = signal<Track | null>(null);
  protected readonly suggestions = signal<readonly ImportCandidate[]>([]);
  protected readonly searching = signal(false);
  protected readonly searchError = signal('');
  protected readonly link = signal('');
  protected readonly error = signal('');
  /** Candidate id (or `pasteId`) being checked. */
  protected readonly checkingId = signal<string | null>(null);
  protected readonly checking = () => this.checkingId() !== null;

  private abort: AbortController | null = null;

  constructor() {
    void this.library
      .ready()
      .catch(() => undefined)
      .finally(() => this.loaded.set(true));
    inject(DestroyRef).onDestroy(() => {
      this.abort?.abort();
      void this.preview.stop();
    });
  }

  protected retry(track: Track): void {
    void this.store.retry(track.id).catch(() => {
      this.toast.show(`Could not retry “${track.title}”. Try again.`);
    });
  }

  protected async retryAll(): Promise<void> {
    if (this.retryingAll()) return;
    this.retryingAll.set(true);
    try {
      const tracks = this.store.tracks();
      let failed = 0;
      for (const track of tracks) {
        try {
          await this.store.retry(track.id);
        } catch {
          failed += 1;
        }
      }
      if (failed)
        this.toast.show(`Could not retry ${failed} download${failed === 1 ? '' : 's'}. Try again.`);
    } finally {
      this.retryingAll.set(false);
    }
  }

  protected openFix(track: Track): void {
    this.abort?.abort();
    const abort = (this.abort = new AbortController());
    this.fixing.set(track);
    this.suggestions.set([]);
    this.searchError.set('');
    this.error.set('');
    this.link.set('');
    this.checkingId.set(null);
    this.searching.set(true);
    this.store
      .suggest(track, abort.signal)
      .then((list) => {
        if (!abort.signal.aborted) this.suggestions.set(list);
      })
      .catch((error: unknown) => {
        if (abort.signal.aborted || isAbort(error)) return;
        this.searchError.set(error instanceof Error ? error.message : 'Could not search. Paste a link instead.');
      })
      .finally(() => {
        if (this.abort === abort) this.searching.set(false);
      });
  }

  protected closeFix(): void {
    this.abort?.abort();
    this.abort = null;
    void this.preview.stop();
    this.fixing.set(null);
    this.searching.set(false);
    this.checkingId.set(null);
  }

  protected onInput(event: Event): void {
    this.link.set((event.target as HTMLInputElement).value);
    this.error.set('');
  }

  protected useCandidate(candidate: Track): void {
    void this.apply(candidate.id, (signal) => this.store.checkCandidate(candidate, signal));
  }

  protected submitLink(event: Event): void {
    event.preventDefault();
    if (this.checking() || !this.link().trim()) return;
    void this.preview.stop();
    const link = this.link();
    void this.apply(this.pasteId, (signal) => this.store.checkLink(link, signal));
  }

  /** Check a candidate, then swap the failed track for it. Errors stay inline; nothing is saved. */
  private async apply(id: string, check: (signal: AbortSignal) => Promise<Track>): Promise<void> {
    const track = this.fixing();
    const abort = this.abort;
    if (!track || !abort || this.checking()) return;
    this.error.set('');
    this.checkingId.set(id);
    try {
      const candidate = await check(abort.signal);
      if (abort.signal.aborted) return;
      await this.store.replace(track.id, candidate);
      this.closeFix();
      this.toast.show(`Link replaced. Downloading “${track.title}”.`);
    } catch (error) {
      if (abort.signal.aborted || isAbort(error)) return;
      this.error.set(error instanceof Error ? error.message : 'Something went wrong. Try again.');
    } finally {
      if (this.abort === abort) this.checkingId.set(null);
    }
  }
}
