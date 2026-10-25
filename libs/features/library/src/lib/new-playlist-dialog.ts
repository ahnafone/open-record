import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  model,
  output,
  signal,
} from '@angular/core';
import type { Playlist } from '@open-record/models';
import {
  PLAYLIST_NAME_MAX,
  PlaylistsStore,
  type PlaylistVisibility,
} from '@open-record/state';
import { OrButton, OrModal } from '@open-record/ui';

/** Validation message for a playlist name, or '' when it is valid. */
export function playlistNameError(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return 'Enter a name for this playlist.';
  if (trimmed.length > PLAYLIST_NAME_MAX) {
    return `Keep the name to ${PLAYLIST_NAME_MAX} characters or fewer.`;
  }
  return '';
}

/** "New playlist" modal: name + visibility, validated before creating. */
@Component({
  selector: 'or-new-playlist-dialog',
  imports: [OrButton, OrModal],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <or-modal heading="New playlist" [(open)]="open" (dismissed)="reset()">
      <form class="form" id="new-playlist-form" novalidate (submit)="submit($event)">
        <div class="field">
          <label for="pl-name">Name</label>
          <input
            id="pl-name"
            type="text"
            autocomplete="off"
            placeholder="e.g. Sunday morning crates"
            aria-describedby="pl-name-err"
            [value]="name()"
            [attr.aria-invalid]="shownError() ? 'true' : 'false'"
            (input)="onInput($event)"
            (blur)="touched.set(true)"
          />
          <p class="field-err" id="pl-name-err" aria-live="polite">
            {{ shownError() }}
          </p>
        </div>
        <div class="field">
          <label for="pl-vis">Visibility</label>
          <select id="pl-vis" [value]="visibility()" (change)="onVisibility($event)">
            <option value="private">Private (only you)</option>
            <option value="public">Public</option>
          </select>
        </div>
      </form>
      <div orModalActions>
        <or-button
          variant="primary"
          block
          [disabled]="saving()"
          (click)="submit()"
        >
          Create playlist
        </or-button>
        <or-button block (click)="close()">Cancel</or-button>
      </div>
    </or-modal>
  `,
  styles: `
    :host {
      display: contents;
    }
    .form {
      display: grid;
      gap: var(--spacing-md);
    }
    .field {
      display: grid;
      gap: var(--spacing-xs);
    }
    label {
      font-size: 11px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--color-muted);
    }
    input,
    select {
      inline-size: 100%;
      min-block-size: var(--spacing-touch);
      padding: 0 10px;
      font: inherit;
      color: var(--color-text);
      background: var(--color-background);
      border: 1px solid var(--color-border);
      border-radius: var(--rounded-md);
      outline: none;
      transition: border-color var(--duration-fast) var(--ease-standard);
    }
    input:focus,
    select:focus,
    input[aria-invalid='true'] {
      border-color: var(--color-primary);
    }
    input:focus-visible,
    select:focus-visible {
      outline: 2px solid var(--color-primary);
      outline-offset: 2px;
    }
    .field-err {
      margin: 0;
      min-block-size: 1.4em;
      color: var(--color-primary);
      font-size: 12px;
      line-height: 1.4;
    }
    @media (prefers-reduced-motion: reduce) {
      input,
      select {
        transition-duration: 1ms;
      }
    }
  `,
})
export class NewPlaylistDialog {
  private readonly playlists = inject(PlaylistsStore);

  readonly open = model(false);
  /** Emitted with the new playlist once it has been saved. */
  readonly created = output<Playlist>();

  protected readonly name = signal('');
  protected readonly visibility = signal<PlaylistVisibility>('private');
  protected readonly touched = signal(false);
  protected readonly saving = signal(false);
  private readonly saveError = signal('');

  protected readonly shownError = computed(
    () =>
      this.saveError() ||
      (this.touched() ? playlistNameError(this.name()) : ''),
  );

  protected onInput(event: Event): void {
    this.name.set((event.target as HTMLInputElement).value);
    this.saveError.set('');
    this.touched.set(true);
  }

  protected onVisibility(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    this.visibility.set(value === 'public' ? 'public' : 'private');
  }

  protected async submit(event?: Event): Promise<void> {
    event?.preventDefault();
    if (this.saving()) return;
    this.touched.set(true);
    if (playlistNameError(this.name())) return;
    this.saving.set(true);
    try {
      const playlist = await this.playlists.create(
        this.name(),
        this.visibility(),
      );
      this.close();
      this.created.emit(playlist);
    } catch (err) {
      this.saveError.set(
        err instanceof Error && err.message
          ? err.message
          : 'Could not create the playlist. Try again.',
      );
    } finally {
      this.saving.set(false);
    }
  }

  protected close(): void {
    this.open.set(false);
    this.reset();
  }

  protected reset(): void {
    this.name.set('');
    this.visibility.set('private');
    this.touched.set(false);
    this.saveError.set('');
  }
}
