import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  model,
  output,
  signal,
  viewChild,
  type ElementRef,
} from '@angular/core';
import { ImportStore, LibraryStore, type ParsedImport } from '@open-record/state';
import { OrButton, OrIcon, OrToast } from '@open-record/ui';
import { SHARED_STYLES } from './shared';
import { YoutubeSource } from './youtube-source';

export type ImportSource = 'audio' | 'exportify' | 'json' | 'youtube';
export interface LoadedFile {
  name: string;
  parsed: ParsedImport;
  /** True when the CSV text was pasted rather than picked. */
  pasted?: boolean;
}

export const EXPORTIFY_URL = 'https://exportify.app';

const SOURCES: readonly { id: ImportSource; title: string; hint: string }[] = [
  {
    id: 'audio',
    title: 'Audio files on this device',
    hint: 'Add audio files from this device. They are copied into the app and play like any other record.',
  },
  {
    id: 'exportify',
    title: 'Exportify (CSV)',
    hint: 'A free site that exports your Spotify playlists as CSV. Copy the text and paste it here, or pick the .csv file.',
  },
  {
    id: 'json',
    title: 'Spotify data download (JSON)',
    hint: 'Spotify > Privacy > Download your data. Unzip it first, then pick the playlist and library .json files.',
  },
  {
    id: 'youtube',
    title: 'YouTube or YT Music playlist or song',
    hint: 'Paste the link of a public or unlisted playlist (made into a new playlist) or of a single song (added to your library). Song details are tidied up in the background.',
  },
];

/** Step 1: choose where the playlists come from. */
@Component({
  selector: 'or-source-step',
  imports: [OrButton, OrIcon, YoutubeSource],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(dragenter)': 'onDragOver($event)',
    '(dragover)': 'onDragOver($event)',
    '(dragleave)': 'onDragLeave($event)',
    '(drop)': 'onDrop($event)',
  },
  template: `
    <div class="drop" [class.active]="dragging()" aria-hidden="true">
      <or-icon name="upload" [size]="24" />
      <span>{{ dragging() ? 'Drop to add' : 'Drag an Exportify .csv or Spotify .json file here' }}</span>
    </div>
    <div class="sources" role="radiogroup" aria-label="Import source">
      @for (s of sources; track s.id) {
        <button
          type="button"
          class="source"
          role="radio"
          [attr.aria-checked]="source() === s.id"
          (click)="choose(s.id)"
        >
          <span class="mark" aria-hidden="true"></span>
          <span class="text">
            <span class="name">{{ s.title }}</span>
            <span class="hint">{{ s.hint }}</span>
          </span>
        </button>
        @if (source() === s.id) {
          <div class="detail">
            @if (s.id === 'youtube') {
              <or-youtube-source (imported)="youtubeImported.emit()" />
            } @else if (s.id === 'audio') {
              <or-button
                block
                [disabled]="!library.canImport || importing()"
                [ariaLabel]="importing() ? 'Importing audio files' : ''"
                (click)="importAudio()"
              >
                <or-icon name="plus" [size]="20" />{{ importing() ? 'Importing…' : 'Choose audio files' }}
              </or-button>
              @if (!library.canImport) {
                <p class="note">Importing is not available on this device.</p>
              }
            } @else {
            @if (s.id === 'exportify') {
              <ol class="steps">
                <li>Open Exportify.</li>
                <li>Log in with Spotify.</li>
                <li>Export a playlist or Liked Songs (or Export All).</li>
                <li>Open the CSV file and copy all of its text.</li>
                <li>Come back and paste it below, one playlist at a time.</li>
              </ol>
              <or-button block (click)="openExportify()"><or-icon name="link" [size]="20" />Open Exportify</or-button>

              <div class="field">
                <label class="field-label" for="or-paste-name">Playlist name (optional)</label>
                <input
                  #nameInput
                  id="or-paste-name"
                  type="text"
                  autocomplete="off"
                  [placeholder]="defaultName()"
                />
              </div>
              <div class="field">
                <label class="field-label" for="or-paste-csv">Pasted CSV</label>
                <textarea
                  #pasteInput
                  id="or-paste-csv"
                  rows="6"
                  wrap="off"
                  spellcheck="false"
                  autocomplete="off"
                  autocapitalize="off"
                  placeholder="Track URI,Track Name,Artist Name(s),…"
                  aria-describedby="or-import-status"
                  [attr.aria-invalid]="error() ? 'true' : 'false'"
                  (input)="onPasteInput()"
                ></textarea>
              </div>
              <div class="actions">
                <or-button [disabled]="!hasPaste() || reading()" (click)="readPaste()">Read pasted CSV</or-button>
                <or-button [disabled]="!store.canPickFile || picking()" (click)="pick()">
                  <or-icon name="plus" [size]="20" />Choose CSV file
                </or-button>
              </div>
            } @else {
              <or-button block [disabled]="!store.canPickFile || picking()" (click)="pick()">
                <or-icon name="plus" [size]="20" />{{ files().length ? 'Add another file' : 'Choose file' }}
              </or-button>
            }
            @if (!store.canPickFile) {
              <p class="note">Picking files is not available on this device.</p>
            }
            @if (files().length) {
              <ul class="files">
                @for (f of files(); track $index) {
                  <li>{{ f.name }} · {{ describe(f.parsed) }}</li>
                }
              </ul>
            }
            <p class="status bad" id="or-import-status" role="status">{{ error() }}</p>
            <label class="like-too">
              <input type="checkbox" [checked]="likeToo()" (change)="likeToo.set(!likeToo())" />
              <span>Also add these songs to Liked Songs</span>
            </label>
            <div class="actions">
              <or-button variant="primary" [disabled]="!files().length || busy()" (click)="filesReady.emit()">{{ busy() ? 'Importing…' : 'Import' }}</or-button>
              @if (files().length) {
                <or-button (click)="clear.emit()">Clear all</or-button>
              }
            </div>
            }
          </div>
        }
      }
    </div>
  `,
  styles: [
    SHARED_STYLES,
    `
      .like-too { display: flex; align-items: center; gap: var(--spacing-sm); min-block-size: var(--spacing-touch); font-size: 14px; cursor: pointer; }
      .like-too input { inline-size: 22px; block-size: 22px; margin: 0; accent-color: var(--color-primary); cursor: pointer; }
    `,
    `
      .sources { display: grid; gap: var(--spacing-sm); }
      .source { display: flex; align-items: flex-start; gap: var(--spacing-md); min-block-size: var(--spacing-touch); padding: var(--spacing-md);
        font: inherit; text-align: start; color: var(--color-text); background: var(--color-surface);
        border: 1px solid color-mix(in srgb, var(--color-border) 45%, transparent); border-radius: var(--rounded-md); cursor: pointer;
        transition: background-color var(--duration-fast) var(--ease-standard); }
      .source:hover { background: var(--color-surface-raised); }
      .source:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 2px; }
      .source[aria-checked='true'] { border-color: var(--color-primary); }
      .mark { flex: none; inline-size: 18px; block-size: 18px; margin-top: 2px; border: 2px solid var(--color-muted); border-radius: 50%; }
      [aria-checked='true'] .mark { border-color: var(--color-primary); background: radial-gradient(circle, var(--color-primary) 0 4px, transparent 5px); }
      .text { display: grid; gap: 2px; }
      .name { font-family: var(--font-display); font-size: 18px; line-height: 1.25; }
      .hint { font-size: 13px; line-height: 1.45; color: var(--color-muted); }
      .detail { padding: var(--spacing-sm) 0 var(--spacing-md); }
      .steps { margin: 0 0 var(--spacing-md); padding-inline-start: 22px; font-size: 14px; line-height: 1.5; }
      .steps li + li { margin-top: var(--spacing-xs); }
      .field { display: grid; gap: var(--spacing-xs); margin-top: var(--spacing-md); }
      .field-label { font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--color-muted); }
      input, textarea { inline-size: 100%; min-block-size: var(--spacing-touch); padding: 10px; font: inherit; color: var(--color-text);
        background: var(--color-background); border: 1px solid var(--color-border); border-radius: var(--rounded-md); outline: none;
        transition: border-color var(--duration-fast) var(--ease-standard); }
      textarea { min-block-size: 132px; resize: vertical; font-size: 13px; line-height: 1.45; white-space: pre; overflow: auto; }
      input:focus, textarea:focus, textarea[aria-invalid='true'] { border-color: var(--color-primary); }
      input:focus-visible, textarea:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 2px; }
      .files { margin: var(--spacing-sm) 0 0; padding-inline-start: 18px; font-size: 13px; color: var(--color-muted); overflow-wrap: anywhere; }
      /* Drop zone: desktop pointers only (phones pick or paste instead). */
      .drop { display: none; }
      @media (min-width: 900px) and (hover: hover) {
        .drop { display: flex; align-items: center; justify-content: center; gap: var(--spacing-sm); min-block-size: 88px;
          margin-bottom: var(--spacing-md); padding: var(--spacing-md); font-size: 13px; color: var(--color-muted); text-align: center;
          border: 1px dashed var(--color-border); border-radius: var(--rounded-md);
          transition: border-color var(--duration-fast) var(--ease-standard), background-color var(--duration-fast) var(--ease-standard); }
        .drop.active { color: var(--color-text); border-color: var(--color-primary);
          background: color-mix(in srgb, var(--color-primary) 10%, transparent); }
      }
      @media (prefers-reduced-motion: reduce) { .source, input, textarea, .drop { transition-duration: 1ms; } }
    `,
  ],
})
export class SourceStep {
  protected readonly store = inject(ImportStore);
  protected readonly library = inject(LibraryStore);
  private readonly toast = inject(OrToast);
  protected readonly importing = signal(false);
  protected readonly sources = SOURCES;

  readonly files = input<readonly LoadedFile[]>([]);
  readonly fileAdded = output<LoadedFile>();
  readonly filesReady = output<void>();
  /** A YouTube link was imported into the job (the page switches to the job view). */
  readonly youtubeImported = output<void>();
  readonly busy = input(false);
  readonly clear = output<void>();

  protected readonly source = signal<ImportSource | null>(null);
  protected readonly picking = signal(false);
  protected readonly reading = signal(false);
  /** Only tracks emptiness: the pasted text itself is read from the element on demand (it can be megabytes). */
  protected readonly hasPaste = signal(false);
  protected readonly error = signal('');
  protected readonly dragging = signal(false);
  protected readonly defaultName = computed(() => `Imported playlist ${this.files().filter((f) => f.pasted).length + 1}`);

  private readonly pasteInput = viewChild<ElementRef<HTMLTextAreaElement>>('pasteInput');
  /** "Also add these songs to Liked Songs": applied to every file when Import is pressed. */
  readonly likeToo = model(false);
  private readonly nameInput = viewChild<ElementRef<HTMLInputElement>>('nameInput');

  protected choose(id: ImportSource): void {
    this.source.set(this.source() === id ? null : id);
    this.error.set('');
    this.hasPaste.set(false);
  }

  protected openExportify(): void {
    // Capacitor hands `_blank` links to the system browser.
    window.open(EXPORTIFY_URL, '_blank', 'noopener');
  }

  protected onPasteInput(): void {
    this.hasPaste.set(!!this.pasteInput()?.nativeElement.value.trim().length);
    if (this.error()) this.error.set('');
  }

  /** Copy picked audio files into the library (no matching step: they are playable at once). */
  protected async importAudio(): Promise<void> {
    if (!this.library.canImport || this.importing()) return;
    this.importing.set(true);
    try {
      const { imported, failures } = await this.library.importFiles();
      const n = imported.length;
      const f = failures.length;
      if (n && f) {
        this.toast.show(
          `Imported ${n} record${n === 1 ? '' : 's'}; ${f} file${f === 1 ? '' : 's'} failed`,
          3200,
        );
      } else if (n) {
        this.toast.show(`Imported ${n} record${n === 1 ? '' : 's'}`);
      } else if (f) {
        const name = f === 1 ? failures[0].fileName : `${f} files`;
        this.toast.show(`Could not import ${name}`, 3200);
      }
    } catch {
      this.toast.show('Could not import files. Try again.');
    } finally {
      this.importing.set(false);
    }
  }

  protected describe(p: ParsedImport): string {
    const parts: string[] = [];
    if (p.playlists.length) parts.push(`${p.playlists.length} playlist${p.playlists.length === 1 ? '' : 's'}`);
    if (p.liked.length) parts.push(`${p.liked.length} liked song${p.liked.length === 1 ? '' : 's'}`);
    return parts.join(', ') || 'nothing to import';
  }

  /** Parse the pasted Exportify CSV as one playlist, named from the optional name field. */
  protected async readPaste(): Promise<void> {
    const area = this.pasteInput()?.nativeElement;
    const nameField = this.nameInput()?.nativeElement;
    if (!area) return;
    this.reading.set(true);
    this.error.set('');
    // Let the disabled state paint before parsing a large paste.
    await new Promise((resolve) => setTimeout(resolve));
    try {
      // The parser names the playlist from a file name: keep slashes out of it.
      const name = (nameField?.value.trim() || this.defaultName()).replace(/[\\/]/g, '-');
      const parsed = this.store.parseFile(`${name}.csv`, area.value);
      if (!parsed.playlists.length && !parsed.liked.length) {
        this.error.set('The pasted CSV has no tracks to import.');
        return;
      }
      this.fileAdded.emit({ name: `${name} (pasted)`, parsed, pasted: true });
      this.toast.show(`Added ${name}`);
      area.value = '';
      if (nameField) nameField.value = '';
      this.hasPaste.set(false);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Could not read the pasted CSV.');
    } finally {
      this.reading.set(false);
    }
  }

  protected onDragOver(event: DragEvent): void {
    if (!event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    this.dragging.set(true);
  }

  protected onDragLeave(event: DragEvent): void {
    const next = event.relatedTarget as Node | null;
    if (!next || !(event.currentTarget as Node).contains(next)) this.dragging.set(false);
  }

  /** Dropped .csv/.json files go through the same parser as picked ones. */
  protected async onDrop(event: DragEvent): Promise<void> {
    if (!event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    this.dragging.set(false);
    this.error.set('');
    const files = Array.from(event.dataTransfer.files);
    for (const file of files) {
      if (!/\.(csv|json)$/i.test(file.name)) {
        this.error.set(`${file.name} is not a .csv or .json file.`);
        continue;
      }
      try {
        const parsed = this.store.parseFile(file.name, await file.text());
        if (!parsed.playlists.length && !parsed.liked.length) {
          this.error.set(`${file.name} has no tracks to import.`);
          continue;
        }
        this.fileAdded.emit({ name: file.name, parsed });
        this.toast.show(`Added ${file.name}`);
      } catch (error) {
        this.error.set(error instanceof Error ? error.message : `Could not read ${file.name}.`);
      }
    }
    // Show the list and Continue button for the matching source.
    if (!this.source()) this.source.set(files.some((f) => /\.json$/i.test(f.name)) ? 'json' : 'exportify');
  }

  protected async pick(): Promise<void> {
    this.picking.set(true);
    this.error.set('');
    try {
      const file = await this.store.pickFile();
      if (!file) return;
      if (!file.parsed.playlists.length && !file.parsed.liked.length) {
        this.error.set(`${file.name} has no tracks to import.`);
        return;
      }
      this.fileAdded.emit(file);
      this.toast.show(`Added ${file.name}`);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Could not read that file.');
    } finally {
      this.picking.set(false);
    }
  }
}
