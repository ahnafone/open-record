import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  model,
  signal,
  untracked,
} from '@angular/core';
import { PLAYLIST_NAME_MAX, PlaylistsStore } from '@open-record/state';
import { OrButton, OrModal, OrToast } from '@open-record/ui';

/** Validation message for a playlist name, or '' when it is valid. */
export function playlistNameError(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return 'Enter a name for this playlist.';
  if (trimmed.length > PLAYLIST_NAME_MAX) {
    return `Keep the name to ${PLAYLIST_NAME_MAX} characters or fewer.`;
  }
  return '';
}

/** "Rename playlist" modal: one validated name field. */
@Component({
  selector: 'or-rename-playlist-dialog',
  imports: [OrButton, OrModal],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <or-modal heading="Rename playlist" [(open)]="open">
      <form class="field" novalidate (submit)="submit($event)">
        <label for="pl-rename">Name</label>
        <input
          id="pl-rename"
          type="text"
          autocomplete="off"
          aria-describedby="pl-rename-err"
          [value]="name()"
          [attr.aria-invalid]="error() ? 'true' : 'false'"
          (input)="onInput($event)"
        />
        <p class="field-err" id="pl-rename-err" aria-live="polite">
          {{ error() }}
        </p>
      </form>
      <div orModalActions>
        <or-button
          variant="primary"
          block
          [disabled]="saving() || !!nameError()"
          (click)="submit()"
        >
          Save name
        </or-button>
        <or-button block (click)="open.set(false)">Cancel</or-button>
      </div>
    </or-modal>
  `,
  styles: `
    :host {
      display: contents;
    }
    .field {
      display: grid;
      gap: var(--spacing-xs);
      margin: 0;
    }
    label {
      font-size: 11px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--color-muted);
    }
    input {
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
    input[aria-invalid='true'] {
      border-color: var(--color-primary);
    }
    input:focus-visible {
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
      input {
        transition-duration: 1ms;
      }
    }
  `,
})
export class RenamePlaylistDialog {
  private readonly playlists = inject(PlaylistsStore);
  private readonly toast = inject(OrToast);

  readonly open = model(false);
  readonly playlistId = input.required<string>();
  readonly currentName = input.required<string>();

  protected readonly name = signal('');
  protected readonly saving = signal(false);
  private readonly saveError = signal('');

  protected readonly nameError = computed(() => playlistNameError(this.name()));
  protected readonly error = computed(
    () => this.saveError() || this.nameError(),
  );

  constructor() {
    // Start from the current name each time the modal opens.
    effect(() => {
      if (!this.open()) return;
      untracked(() => {
        this.name.set(this.currentName());
        this.saveError.set('');
      });
    });
  }

  protected onInput(event: Event): void {
    this.name.set((event.target as HTMLInputElement).value);
    this.saveError.set('');
  }

  protected async submit(event?: Event): Promise<void> {
    event?.preventDefault();
    if (this.saving() || this.nameError()) return;
    if (this.name().trim() === this.currentName()) {
      this.open.set(false);
      return;
    }
    this.saving.set(true);
    try {
      await this.playlists.rename(this.playlistId(), this.name());
      this.open.set(false);
      this.toast.show('Playlist renamed');
    } catch (err) {
      this.saveError.set(
        err instanceof Error && err.message
          ? err.message
          : 'Could not rename the playlist. Try again.',
      );
    } finally {
      this.saving.set(false);
    }
  }
}
