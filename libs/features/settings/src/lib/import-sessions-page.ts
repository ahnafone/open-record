import {
  ChangeDetectionStrategy,
  Component,
  inject,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  ImportSessionsStore,
  ImportStore,
  LibraryStore,
  formatSessionDate,
  importSessionCounts,
  type ImportSession,
} from '@open-record/state';
import {
  OrButton,
  OrDialog,
  OrEmptyState,
  OrIcon,
  OrSectionHead,
  OrSpinner,
  OrToast,
} from '@open-record/ui';

/** Import history: one card per import run, newest first. */
@Component({
  selector: 'or-import-sessions-page',
  imports: [OrButton, OrEmptyState, OrIcon, OrSectionHead, OrSpinner, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <or-section-head heading="Import history" />
    <p class="lede">
      Each import of audio files or a Spotify export is kept here, so you can
      see what it added later.
    </p>
    @if (!loaded()) {
      <p class="status" role="status"><or-spinner [size]="16" />Loading…</p>
    } @else if (store.sessions().length) {
      <ul class="list">
        @for (s of store.sessions(); track s.id) {
          <li>
            <a class="card" [routerLink]="['/import/sessions', s.id]">
              <span class="info">
                <span class="name">{{ s.label }}</span>
                <span class="meta">{{ date(s.createdAt) }}</span>
                <span class="meta">{{ counts(s) }}</span>
              </span>
              <or-icon class="chev" name="chev-down" [size]="20" />
            </a>
          </li>
        }
      </ul>
    } @else {
      <or-empty-state>
        No imports yet. Imports of audio files or Spotify exports appear here.
      </or-empty-state>
    }
    <section class="manage" aria-labelledby="or-imported-manage">
      <or-section-head heading="Imported files" />
      <p class="lede" id="or-imported-manage">
        Deletes every imported audio file from this device, removes it from playlists and the queue, and clears the audio-file entries here. Spotify and YouTube imports are kept.
      </p>
      <or-button
        block
        variant="danger"
        [disabled]="!imported().length || busy()"
        (click)="clearImported()"
      >
        Clear imported files
      </or-button>
    </section>
  `,
  styles: `
    :host {
      display: block;
      max-inline-size: 800px;
    }
    .lede {
      margin: 0 0 var(--spacing-md);
      font-size: 13px;
      line-height: 1.45;
      color: var(--color-muted);
    }
    .status {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
      min-block-size: var(--spacing-touch);
      margin: 0;
      font-size: 12px;
      color: var(--color-muted);
    }
    .list {
      display: grid;
      gap: var(--spacing-sm);
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .card {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: var(--spacing-sm);
      align-items: center;
      min-block-size: 64px;
      padding: var(--spacing-sm) 10px var(--spacing-sm) var(--spacing-md);
      background: var(--color-surface);
      border: 1px solid color-mix(in srgb, var(--color-border) 50%, transparent);
      border-radius: var(--rounded-md);
      color: inherit;
      text-decoration: none;
      transition: background var(--duration-fast) var(--ease-standard);
    }
    .card:hover {
      background: var(--color-surface-raised);
    }
    .card:focus-visible {
      outline: 2px solid var(--color-primary);
      outline-offset: 2px;
    }
    .info {
      display: grid;
      min-inline-size: 0;
    }
    .name {
      font-family: var(--font-display);
      font-size: 18px;
      line-height: 1.25;
      overflow-wrap: anywhere;
    }
    .meta {
      font-size: var(--type-meta-font-size);
      color: var(--color-muted);
      font-variant-numeric: tabular-nums;
    }
    .manage {
      display: grid;
      margin-top: var(--spacing-lg);
    }
    .chev {
      color: var(--color-muted);
      transform: rotate(-90deg);
    }
    @media (prefers-reduced-motion: reduce) {
      .card {
        transition-duration: 1ms;
      }
    }
  `,
})
export class ImportSessionsPage {
  protected readonly store = inject(ImportSessionsStore);
  protected readonly loaded = signal(false);
  protected readonly date = formatSessionDate;
  private readonly imports = inject(ImportStore);
  private readonly library = inject(LibraryStore);
  private readonly dialog = inject(OrDialog);
  private readonly toast = inject(OrToast);
  protected readonly imported = this.library.importedTracks;
  protected readonly busy = signal(false);

  constructor() {
    void Promise.all([this.store.reload(), this.imports.ready()])
      .catch(() => undefined)
      .finally(() => this.loaded.set(true));
  }

  /** Live match counts for Spotify sessions. */
  protected counts(s: ImportSession): string {
    const states = this.imports.itemStates();
    return importSessionCounts(s, (key) => states.get(key));
  }

  protected async clearImported(): Promise<void> {
    const ok = await this.dialog.confirm({
      title: 'Clear imported files?',
      message:
        'Every imported record and its files will be deleted from this device, and removed from playlists and the queue.',
      confirmLabel: 'Clear imported files',
      danger: true,
    });
    if (!ok) return;
    this.busy.set(true);
    try {
      await this.library.clearImported();
      this.toast.show('Imported files cleared');
    } catch {
      this.toast.show('Something went wrong. Try again.');
    } finally {
      this.busy.set(false);
    }
  }
}
