import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import type { Track } from '@open-record/models';
import {
  LibraryStore,
  SettingsStore,
  type StorageUsage,
} from '@open-record/state';
import {
  OrButton,
  OrDialog,
  OrEmptyState,
  OrIcon,
  OrSectionHead,
  OrSleeve,
  OrToast,
} from '@open-record/ui';
import { METADATA_CREDITS, MUSIC_DISCLAIMER } from './credits';
import { EditTrackDialog } from './edit-track-dialog';
import { formatBytes } from './format-bytes';

/**
 * Settings screen: import audio files, manage imported records, the online
 * metadata switch, on-device storage with clear actions, and credits.
 */
@Component({
  selector: 'or-settings-page',
  imports: [
    EditTrackDialog,
    OrButton,
    OrEmptyState,
    OrIcon,
    OrSectionHead,
    OrSleeve,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <or-section-head heading="Import" />
    <p class="lede">
      Add audio files from this device. They are copied into the app and play
      like any other record.
    </p>
    <or-button
      block
      [disabled]="!library.canImport || importing()"
      [ariaLabel]="importing() ? 'Importing audio files' : ''"
      (click)="importFiles()"
    >
      <or-icon name="plus" [size]="20" />{{
        importing() ? 'Importing…' : 'Import audio files'
      }}
    </or-button>
    @if (!library.canImport) {
      <p class="note">Importing is not available on this device.</p>
    }

    <or-section-head heading="Imported records" />
    @if (imported().length) {
      <ul class="rows">
        @for (track of imported(); track track.id) {
          <li class="row">
            <or-sleeve
              [src]="art()[track.id]"
              [label]="track.title"
              fallbackLabel="No cover art"
            />
            <div class="text">
              <span class="title">{{ track.title }}</span>
              <span class="artist">{{ track.artist }}</span>
              <span class="detail">{{ statusText(track) }}</span>
              <div class="row-actions">
                <or-button
                  size="sm"
                  [ariaLabel]="'Edit ' + track.title"
                  (click)="editing.set(track)"
                >
                  Edit
                </or-button>
                <or-button
                  size="sm"
                  [ariaLabel]="'Remove ' + track.title"
                  (click)="remove(track)"
                >
                  <or-icon name="trash" [size]="18" />Remove
                </or-button>
              </div>
            </div>
          </li>
        }
      </ul>
    } @else {
      <or-empty-state>
        No imported records yet. Imported files appear here.
      </or-empty-state>
    }

    <or-section-head heading="Online metadata" />
    <div class="panel">
      <div class="switch-row">
        <span class="switch-text">
          <span class="switch-label" id="online-label">Look up tags online</span>
          <span class="switch-help" id="online-help">
            Looks up tags and cover art on MusicBrainz. Never downloads audio.
            Phone and tablet app only.
          </span>
        </span>
        <button
          type="button"
          role="switch"
          class="switch"
          aria-labelledby="online-label"
          aria-describedby="online-help online-note"
          [attr.aria-checked]="switchOn()"
          [disabled]="!settings.onlineSupported || toggling()"
          (click)="toggleOnline()"
        >
          <span class="knob" aria-hidden="true"></span>
        </button>
      </div>
      <p class="status" id="online-note" aria-live="polite">{{ onlineNote() }}</p>
      <or-button
        block
        [disabled]="!canRefresh()"
        (click)="refreshMetadata()"
      >
        Refresh metadata
      </or-button>
    </div>

    <or-section-head heading="Storage" />
    <dl class="usage" aria-live="polite">
      @for (row of usageRows(); track row.label) {
        <div class="usage-row">
          <dt>{{ row.label }}</dt>
          <dd>{{ row.value }}</dd>
        </div>
      }
    </dl>
    <div class="stack">
      <or-button
        block
        variant="danger"
        [disabled]="!imported().length || busy()"
        (click)="clearImported()"
      >
        Clear imported files
      </or-button>
      <or-button
        block
        variant="danger"
        [disabled]="busy()"
        (click)="clearAll()"
      >
        Clear all data
      </or-button>
    </div>
    <p class="note">
      Clear all data also removes saved records, playlists and settings. The
      bundled catalogue stays.
    </p>

    <or-section-head heading="About" />
    <ul class="credits">
      @for (c of credits; track c.name) {
        <li class="credit">
          <a class="credit-name" [href]="c.url" target="_blank" rel="noopener">
            {{ c.name }}
          </a>
          <span class="credit-text">{{ c.text }}</span>
          <span class="credit-licence">Licence: {{ c.license }}</span>
        </li>
      }
    </ul>
    <p class="disclaimer">
      <span class="eyebrow">Music disclaimer</span>
      {{ disclaimer }}
    </p>

    <or-edit-track-dialog
      [open]="!!editing()"
      (openChange)="$event || editing.set(null)"
      [track]="editing()"
    />
  `,
  styles: `
    :host {
      display: block;
    }
    or-section-head:first-child {
      margin-top: var(--spacing-xs);
    }
    .lede,
    .note,
    .status {
      margin: var(--spacing-xs) 0 var(--spacing-md);
      font-size: 13px;
      line-height: 1.45;
      color: var(--color-muted);
    }
    .note {
      margin: var(--spacing-sm) 0 0;
      font-size: 12px;
    }
    .status {
      min-block-size: 1.45em;
      margin: var(--spacing-sm) 0;
    }
    .rows,
    .credits {
      display: grid;
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .row {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      align-items: start;
      gap: var(--spacing-md);
      min-block-size: 72px;
      padding: var(--spacing-md) 0;
      border-top: 1px solid
        color-mix(in srgb, var(--color-border) 32%, transparent);
    }
    .row:first-child {
      border-top: 0;
    }
    .text {
      display: grid;
      min-inline-size: 0;
    }
    .title {
      font-size: 15px;
      font-weight: 600;
      line-height: 1.3;
      overflow-wrap: anywhere;
    }
    .artist {
      font-size: 13px;
      color: var(--color-muted);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .detail {
      font-size: 12px;
      color: var(--color-muted);
    }
    .row-actions {
      display: flex;
      flex-wrap: wrap;
      gap: var(--spacing-sm);
      margin-top: var(--spacing-sm);
    }
    .panel {
      margin-top: var(--spacing-sm);
      padding: var(--spacing-md);
      background: var(--color-surface);
      border: 1px solid color-mix(in srgb, var(--color-border) 50%, transparent);
      border-radius: var(--rounded-md);
    }
    .switch-row {
      display: flex;
      align-items: flex-start;
      gap: var(--spacing-md);
    }
    .switch-text {
      display: grid;
      flex: 1;
      gap: var(--spacing-xs);
      min-inline-size: 0;
    }
    .switch-label {
      font-size: 15px;
      font-weight: 600;
    }
    .switch-help {
      font-size: 13px;
      line-height: 1.45;
      color: var(--color-muted);
    }
    .switch {
      appearance: none;
      flex: none;
      position: relative;
      inline-size: 52px;
      block-size: 44px;
      padding: 0;
      background: transparent;
      border: 0;
      border-radius: var(--rounded-md);
      cursor: pointer;
    }
    .switch::before {
      content: '';
      position: absolute;
      inset: 10px 2px;
      border-radius: var(--rounded-full);
      background: var(--color-background);
      border: 1px solid var(--color-border);
      transition:
        background var(--duration-fast) var(--ease-standard),
        border-color var(--duration-fast) var(--ease-standard);
    }
    .knob {
      position: absolute;
      inset-block-start: 14px;
      inset-inline-start: 6px;
      inline-size: 16px;
      block-size: 16px;
      border-radius: 50%;
      background: var(--color-muted);
      transition:
        transform var(--duration-fast) var(--ease-standard),
        background var(--duration-fast) var(--ease-standard);
    }
    .switch[aria-checked='true']::before {
      background: var(--color-primary);
      border-color: var(--color-primary);
    }
    .switch[aria-checked='true'] .knob {
      transform: translateX(24px);
      background: var(--color-on-primary);
    }
    .switch:disabled {
      opacity: 0.42;
      cursor: not-allowed;
    }
    .switch:focus-visible {
      outline: 2px solid var(--color-primary);
      outline-offset: 2px;
    }
    .usage {
      display: grid;
      margin: var(--spacing-sm) 0 var(--spacing-md);
    }
    .usage-row {
      display: flex;
      justify-content: space-between;
      gap: var(--spacing-md);
      padding: 10px 0;
      font-size: 14px;
      border-top: 1px solid
        color-mix(in srgb, var(--color-border) 32%, transparent);
    }
    .usage-row:first-child {
      border-top: 0;
    }
    .usage-row:last-child dt {
      font-weight: 600;
    }
    dt {
      color: var(--color-text);
    }
    dd {
      margin: 0;
      color: var(--color-muted);
      font-variant-numeric: tabular-nums;
      text-align: end;
    }
    .stack {
      display: grid;
      gap: var(--spacing-sm);
    }
    .credits {
      gap: var(--spacing-md);
      margin-top: var(--spacing-sm);
    }
    .credit {
      display: grid;
      gap: 2px;
      font-size: 13px;
      line-height: 1.45;
      color: var(--color-muted);
    }
    .credit-name {
      justify-self: start;
      display: inline-flex;
      align-items: center;
      min-block-size: var(--spacing-touch);
      font-family: var(--font-display);
      font-size: 18px;
      color: var(--color-text);
      text-decoration: underline;
      text-decoration-color: color-mix(
        in srgb,
        var(--color-border) 75%,
        transparent
      );
      text-underline-offset: 3px;
      border-radius: var(--rounded-md);
    }
    .credit-name:focus-visible {
      outline: 2px solid var(--color-primary);
      outline-offset: 2px;
    }
    .credit-licence {
      font-size: 12px;
    }
    .disclaimer {
      display: grid;
      gap: var(--spacing-xs);
      margin: var(--spacing-lg) 0 0;
      padding: var(--spacing-md);
      font-size: 13px;
      line-height: 1.45;
      color: var(--color-muted);
      border: 1px dashed color-mix(in srgb, var(--color-border) 75%, transparent);
      border-radius: var(--rounded-md);
    }
    .eyebrow {
      font-size: 11px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
    }
    @media (prefers-reduced-motion: reduce) {
      .switch::before,
      .knob {
        transition-duration: 1ms;
      }
    }
  `,
})
export class SettingsPage {
  protected readonly library = inject(LibraryStore);
  protected readonly settings = inject(SettingsStore);
  private readonly dialog = inject(OrDialog);
  private readonly toast = inject(OrToast);

  protected readonly credits = METADATA_CREDITS;
  protected readonly disclaimer = MUSIC_DISCLAIMER;

  protected readonly imported = this.library.importedTracks;
  protected readonly importing = signal(false);
  protected readonly toggling = signal(false);
  protected readonly busy = signal(false);
  protected readonly editing = signal<Track | null>(null);

  /** Resolved cover URLs by track id (resolved at display time, never stored). */
  protected readonly art = signal<Record<string, string | undefined>>({});
  private readonly usage = signal<StorageUsage | null>(null);
  private usageRun = 0;
  private artRun = 0;

  protected readonly switchOn = computed(
    () => this.settings.onlineSupported && this.settings.onlineMetadata(),
  );

  protected readonly onlineNote = computed(() => {
    if (!this.settings.onlineSupported) {
      return 'Not available in the web version. Use the phone or tablet app.';
    }
    const p = this.library.enrichProgress();
    if (p.running) return `Looking up records: ${p.done} of ${p.total}`;
    if (!this.settings.onlineMetadata()) return 'Off. Records keep their file tags.';
    if (p.total) {
      return `Checked ${p.done} record${p.done === 1 ? '' : 's'} in the last run.`;
    }
    return 'On. New imports are looked up in the background.';
  });

  private readonly lookupRunning = computed(
    () => this.library.enrichProgress().running,
  );

  protected readonly canRefresh = computed(
    () =>
      this.settings.onlineEnabled() &&
      !this.library.enrichProgress().running &&
      this.imported().length > 0,
  );

  protected readonly usageRows = computed(() => {
    const u = this.usage();
    const fmt = (n: number | null | undefined) =>
      u ? (n == null ? 'Unknown' : formatBytes(n)) : '…';
    return [
      { label: 'Imported audio', value: fmt(u?.importedAudioBytes) },
      { label: 'Cover art', value: fmt(u?.artBytes) },
      { label: 'Metadata', value: fmt(u?.metadataBytes) },
      { label: 'Bundled catalogue', value: fmt(u?.catalogBytes) },
      { label: 'You can free', value: fmt(u?.removableBytes) },
    ];
  });

  constructor() {
    // Resolve cover art for imported tracks whenever the list changes.
    effect(() => {
      const tracks = this.imported();
      untracked(() => void this.resolveArt(tracks));
    });
    // Re-measure storage when imports change or a lookup run finishes.
    effect(() => {
      this.imported();
      this.lookupRunning();
      untracked(() => void this.refreshUsage());
    });
  }

  protected statusText(track: Track): string {
    const details = [track.album, track.year].filter(Boolean).join(' · ');
    const status = this.enrichmentText(track);
    return details ? `${details} · ${status}` : status;
  }

  private enrichmentText(track: Track): string {
    switch (track.enrichment) {
      case 'done':
        return 'Tags checked online';
      case 'failed':
        return 'No online match';
      case 'pending':
        return this.settings.onlineEnabled()
          ? 'Waiting for lookup'
          : 'File tags only';
      default:
        return 'File tags only';
    }
  }

  protected async importFiles(): Promise<void> {
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

  protected async remove(track: Track): Promise<void> {
    const ok = await this.dialog.confirm({
      title: 'Remove record?',
      message: `"${track.title}" and its file will be deleted from this device, and removed from playlists and the queue.`,
      confirmLabel: 'Remove record',
      danger: true,
    });
    if (!ok) return;
    try {
      await this.library.removeImported(track.id);
      this.toast.show('Record removed');
    } catch {
      this.toast.show('Could not remove that record. Try again.');
    }
  }

  protected async toggleOnline(): Promise<void> {
    if (!this.settings.onlineSupported || this.toggling()) return;
    this.toggling.set(true);
    try {
      await this.settings.setOnlineMetadata(!this.settings.onlineMetadata());
    } catch {
      this.toast.show('Could not change the setting. Try again.');
    } finally {
      this.toggling.set(false);
    }
  }

  protected async refreshMetadata(): Promise<void> {
    if (!this.canRefresh()) return;
    try {
      await this.library.refreshMetadata();
      this.toast.show('Looking up records again');
    } catch {
      this.toast.show('Could not refresh metadata. Try again.');
    }
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
    await this.run(() => this.library.clearImported(), 'Imported files cleared');
  }

  protected async clearAll(): Promise<void> {
    const ok = await this.dialog.confirm({
      title: 'Clear all data?',
      message:
        'This deletes imported files, saved records, playlists and settings. It cannot be undone.',
      confirmLabel: 'Clear all data',
      danger: true,
    });
    if (!ok) return;
    await this.run(() => this.library.clearAll(), 'All data cleared');
  }

  private async run(action: () => Promise<void>, done: string): Promise<void> {
    this.busy.set(true);
    try {
      await action();
      this.toast.show(done);
    } catch {
      this.toast.show('Something went wrong. Try again.');
    } finally {
      this.busy.set(false);
      void this.refreshUsage();
    }
  }

  private async refreshUsage(): Promise<void> {
    const run = ++this.usageRun;
    try {
      const usage = await this.library.storageUsage();
      if (run === this.usageRun) this.usage.set(usage);
    } catch {
      // Keep the last known figures.
    }
  }

  private async resolveArt(tracks: readonly Track[]): Promise<void> {
    const run = ++this.artRun;
    const entries = await Promise.all(
      tracks.map(async (t) => {
        try {
          return [t.id, await this.library.artUrl(t)] as const;
        } catch {
          return [t.id, undefined] as const;
        }
      }),
    );
    if (run === this.artRun) this.art.set(Object.fromEntries(entries));
  }
}
