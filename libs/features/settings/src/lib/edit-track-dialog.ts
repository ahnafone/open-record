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
import type { Track } from '@open-record/models';
import { LibraryStore, type TrackEdit } from '@open-record/state';
import { OrButton, OrModal, OrToast } from '@open-record/ui';

type Field = 'title' | 'artist' | 'album' | 'year' | 'genre';

interface Draft {
  title: string;
  artist: string;
  album: string;
  year: string;
  genre: string;
}

const EMPTY: Draft = { title: '', artist: '', album: '', year: '', genre: '' };

/** Per-field validation messages ('' when valid). */
export function draftErrors(d: Draft): Record<Field, string> {
  const year = d.year.trim();
  return {
    title: d.title.trim() ? '' : 'Enter a title.',
    artist: d.artist.trim() ? '' : 'Enter an artist.',
    album: '',
    genre: '',
    year:
      !year || (/^\d{1,4}$/.test(year) && Number(year) >= 1)
        ? ''
        : 'Use a year like 1927.',
  };
}

/** "Edit record" modal: title, artist, album, year and genre of an imported track. */
@Component({
  selector: 'or-edit-track-dialog',
  imports: [OrButton, OrModal],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <or-modal heading="Edit record" [(open)]="open">
      <form class="form" novalidate (submit)="submit($event)">
        @for (f of fields; track f.key) {
          <div class="field">
            <label [for]="'edit-' + f.key">{{ f.label }}</label>
            <input
              [id]="'edit-' + f.key"
              type="text"
              autocomplete="off"
              [attr.inputmode]="f.key === 'year' ? 'numeric' : null"
              [attr.maxlength]="f.key === 'year' ? 4 : 200"
              [attr.aria-describedby]="'edit-' + f.key + '-err'"
              [attr.aria-invalid]="shownError(f.key) ? 'true' : 'false'"
              [value]="draft()[f.key]"
              (input)="onInput(f.key, $event)"
              (blur)="touch(f.key)"
            />
            <p class="field-err" [id]="'edit-' + f.key + '-err'" aria-live="polite">
              {{ shownError(f.key) }}
            </p>
          </div>
        }
        <p class="field-err" aria-live="polite">{{ saveError() }}</p>
        <button type="submit" hidden></button>
      </form>
      <div orModalActions>
        <or-button
          variant="primary"
          block
          [disabled]="saving() || invalid()"
          (click)="submit()"
        >
          Save changes
        </or-button>
        <or-button block (click)="open.set(false)">Cancel</or-button>
      </div>
    </or-modal>
  `,
  styles: `
    :host {
      display: contents;
    }
    .form {
      display: grid;
      gap: 2px;
      margin: 0;
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
    input {
      inline-size: 100%;
      min-block-size: var(--spacing-touch);
      padding: 0 10px;
      box-sizing: border-box;
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
export class EditTrackDialog {
  private readonly library = inject(LibraryStore);
  private readonly toast = inject(OrToast);

  readonly open = model(false);
  readonly track = input<Track | null>(null);

  protected readonly fields: readonly { key: Field; label: string }[] = [
    { key: 'title', label: 'Title' },
    { key: 'artist', label: 'Artist' },
    { key: 'album', label: 'Album' },
    { key: 'year', label: 'Year' },
    { key: 'genre', label: 'Genre' },
  ];

  protected readonly draft = signal<Draft>(EMPTY);
  private readonly touched = signal<ReadonlySet<Field>>(new Set());
  protected readonly saving = signal(false);
  protected readonly saveError = signal('');

  private readonly errors = computed(() => draftErrors(this.draft()));
  protected readonly invalid = computed(() =>
    Object.values(this.errors()).some(Boolean),
  );

  constructor() {
    // Start from the record's current values each time the modal opens.
    effect(() => {
      if (!this.open()) return;
      const t = this.track();
      untracked(() => {
        this.draft.set(
          t
            ? {
                title: t.title,
                artist: t.artist,
                album: t.album ?? '',
                year: t.year ? String(t.year) : '',
                genre: t.genre ?? '',
              }
            : EMPTY,
        );
        this.touched.set(new Set());
        this.saveError.set('');
      });
    });
  }

  protected shownError(field: Field): string {
    return this.touched().has(field) ? this.errors()[field] : '';
  }

  protected onInput(field: Field, event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.draft.update((d) => ({ ...d, [field]: value }));
    this.touch(field);
    this.saveError.set('');
  }

  protected touch(field: Field): void {
    if (this.touched().has(field)) return;
    this.touched.update((s) => new Set(s).add(field));
  }

  protected async submit(event?: Event): Promise<void> {
    event?.preventDefault();
    const t = this.track();
    this.touched.set(new Set(this.fields.map((f) => f.key)));
    if (!t || this.saving() || this.invalid()) return;
    const d = this.draft();
    const year = d.year.trim();
    const edit: TrackEdit = {
      title: d.title,
      artist: d.artist,
      album: d.album.trim() || null,
      year: year ? Number(year) : null,
      genre: d.genre.trim() || null,
    };
    this.saving.set(true);
    try {
      await this.library.updateTrack(t.id, edit);
      this.open.set(false);
      this.toast.show('Record updated');
    } catch (err) {
      this.saveError.set(
        err instanceof Error && err.message
          ? err.message
          : 'Could not save the changes. Try again.',
      );
    } finally {
      this.saving.set(false);
    }
  }
}
