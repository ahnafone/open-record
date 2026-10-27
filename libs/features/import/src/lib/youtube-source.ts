import { ChangeDetectionStrategy, Component, DestroyRef, inject, model, output, signal } from '@angular/core';
import { ImportStore } from '@open-record/state';
import { OrButton, OrToast } from '@open-record/ui';
import { SHARED_STYLES } from './shared';

/**
 * YouTube / YT Music source: paste a public playlist link (a new playlist) or a
 * single song link (library only), optionally also added to Liked Songs. The songs join the same import job as every
 * other source; `imported` tells the import page to show that job.
 */
@Component({
  selector: 'or-youtube-source',
  imports: [OrButton],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="field">
      <label class="field-label" for="or-yt-link">Playlist or song link</label>
      <input
        id="or-yt-link"
        type="url"
        inputmode="url"
        autocomplete="off"
        autocapitalize="off"
        spellcheck="false"
        placeholder="https://music.youtube.com/playlist?list=… or /watch?v=…"
        aria-describedby="or-yt-status"
        [value]="link()"
        [attr.aria-invalid]="error() ? 'true' : 'false'"
        (input)="onInput($event)"
        (keydown.enter)="submit()"
      />
    </div>
    <p class="status bad" id="or-yt-status" role="status">{{ error() }}</p>
    <label class="like-too">
      <input type="checkbox" [checked]="likeToo()" [disabled]="store.importing()" (change)="likeToo.set(!likeToo())" />
      <span>Also add to Liked Songs</span>
    </label>
    <div class="actions">
      <or-button variant="primary" [disabled]="!link().trim() || store.importing()" (click)="submit()">
        {{ store.importing() ? 'Importing…' : 'Import' }}
      </or-button>
      @if (store.importing()) {
        <or-button (click)="stop()">Cancel</or-button>
      }
    </div>
    <p class="note">Public and unlisted playlists and single songs only. Songs stream from YouTube; nothing is downloaded until you save it.</p>
  `,
  styles: [
    SHARED_STYLES,
    `
      .field { display: grid; gap: var(--spacing-xs); }
      .field-label { font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--color-muted); }
      input[type='url'] { inline-size: 100%; min-block-size: var(--spacing-touch); padding: 10px; font: inherit; color: var(--color-text);
        background: var(--color-background); border: 1px solid var(--color-border); border-radius: var(--rounded-md); outline: none;
        transition: border-color var(--duration-fast) var(--ease-standard); }
      input[type='url']:focus, input[aria-invalid='true'] { border-color: var(--color-primary); }
      input:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 2px; }
      .like-too { display: flex; align-items: center; gap: var(--spacing-sm); min-block-size: var(--spacing-touch); font-size: 14px; cursor: pointer; }
      .like-too input { inline-size: 22px; block-size: 22px; margin: 0; accent-color: var(--color-primary); cursor: pointer; }
      @media (prefers-reduced-motion: reduce) { input { transition-duration: 1ms; } }
    `,
  ],
})
export class YoutubeSource {
  protected readonly store = inject(ImportStore);
  private readonly toast = inject(OrToast);

  /** The link was imported as a job; the import page shows it. */
  readonly imported = output<void>();
  /** "Also add to Liked Songs": the song, or every playlist song, is bookmarked too. */
  readonly likeToo = model(false);

  protected readonly link = signal('');
  protected readonly error = signal('');

  private abort: AbortController | null = null;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.abort?.abort());
  }

  protected onInput(event: Event): void {
    this.link.set((event.target as HTMLInputElement).value);
    if (this.error()) this.error.set('');
  }

  protected async submit(): Promise<void> {
    const raw = this.link().trim();
    if (!raw || this.store.importing()) return;
    const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    if (!isYoutubeLink(url)) {
      this.error.set('Paste a YouTube or YT Music playlist or song link (youtube.com, music.youtube.com or youtu.be).');
      return;
    }
    this.error.set('');
    const abort = (this.abort = new AbortController());
    try {
      const summary = await this.store.startYoutube(url, abort.signal, { likeToo: this.likeToo() });
      this.link.set('');
      this.toast.show(summary.single ? `Added ${summary.title}` : `Imported ${summary.title}`, 3200);
      this.imported.emit();
    } catch (error) {
      if (abort.signal.aborted) return;
      this.error.set(error instanceof Error ? error.message : 'Could not import that link. Try again.');
    } finally {
      if (this.abort === abort) this.abort = null;
    }
  }

  protected stop(): void {
    this.abort?.abort();
  }
}

const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be']);

/** Quick client-side hint only; the server's allow-list is authoritative. */
function isYoutubeLink(value: string): boolean {
  try {
    const url = new URL(value);
    return YOUTUBE_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}
