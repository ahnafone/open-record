import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterNextRender,
  computed,
  effect,
  inject,
  linkedSignal,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { parsePairingLink, type Track } from '@open-record/models';
import {
  LibraryStore,
  PairingScannerPort,
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
  OrSpinner,
  OrToast,
} from '@open-record/ui';
import { MUSIC_DISCLAIMER } from './credits';
import { EditTrackDialog } from './edit-track-dialog';
import { formatBytes } from './format-bytes';

/**
 * Settings screen: import audio files, the stream server (URL, token,
 * connection test), manage imported records, on-device storage with clear
 * actions, and the music disclaimer.
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
    OrSpinner,
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

    <or-section-head heading="Stream server" />
    <p class="lede">
      Connect your self-hosted Open Record server to search sites and stream
      records. Saved songs live on this device; unsaved songs are streamed.
      Scan the pairing QR code from the server, or paste its pairing link into
      the server URL.
    </p>
    @if (settings.serverAvailable) {
      <form class="server" (submit)="saveServer($event)">
        @if (canScan()) {
          <or-button
            block
            [disabled]="scanning() || savingServer() || testing()"
            (click)="scanQr()"
            >Scan QR code</or-button
          >
        }
        <label class="field-label" for="or-server-url">Server URL</label>
        <input
          id="or-server-url"
          class="input"
          type="url"
          inputmode="url"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          placeholder="https://music.example.com"
          aria-describedby="or-server-status"
          [attr.aria-invalid]="serverError() ? 'true' : null"
          [value]="serverUrl()"
          (input)="onServerInput($event, 'url')"
        />
        <label class="field-label" for="or-server-token">Access token</label>
        <input
          id="or-server-token"
          class="input"
          type="password"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          aria-describedby="or-server-status"
          [value]="serverToken()"
          (input)="onServerInput($event, 'token')"
        />
        <div class="server-actions">
          <or-button
            type="submit"
            [disabled]="savingServer() || !serverDirty()"
          >
            Save
          </or-button>
          <or-button
            [disabled]="savingServer() || testing() || !serverUrl().trim()"
            (click)="testServer()"
          >
            Test connection
          </or-button>
        </div>
        <p id="or-server-status" class="status" role="status">
          @if (serverError(); as e) {
            <span class="status-bad"
              ><or-icon name="alert" [size]="14" />{{ e }}</span
            >
          } @else if (scanning()) {
            <span class="status-muted">Scanning…</span>
          } @else if (testing()) {
            <span class="status-muted"
              ><or-spinner [size]="14" />Testing connection…</span
            >
          } @else if (connection().status === 'ok') {
            <span class="status-ok"
              ><or-icon name="check" [size]="14" />Connected. Streaming is
              ready.</span
            >
          } @else if (connectionError(); as e) {
            <span class="status-bad"
              ><or-icon name="alert" [size]="14" />{{ e }}</span
            >
          } @else if (settings.downloadServerConfigured()) {
            <span class="status-muted"
              >Saved. Test the connection to check it.</span
            >
          } @else {
            <span class="status-muted">No server set up.</span>
          }
        </p>
      </form>
      <p class="note">
        You are responsible for what you stream and save. Only use music you
        have the rights to.
      </p>
      <button type="button" class="text-link" (click)="showDisclaimer()">
        Read the music disclaimer
      </button>
    } @else {
      <p class="note">Streaming from a server is not available in this build.</p>
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
              @if (detailText(track); as detail) {
                <span class="detail">{{ detail }}</span>
              }
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
    <p #disclaimerEl id="music-disclaimer" class="disclaimer" tabindex="-1">
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
    .note {
      margin: var(--spacing-xs) 0 var(--spacing-md);
      font-size: 13px;
      line-height: 1.45;
      color: var(--color-muted);
    }
    .note {
      margin: var(--spacing-sm) 0 0;
      font-size: 12px;
    }
    .rows {
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
    .disclaimer {
      display: grid;
      gap: var(--spacing-xs);
      margin: var(--spacing-lg) 0 0;
      padding: var(--spacing-md);
      font-size: 13px;
      line-height: 1.45;
      color: var(--color-muted);
      border: 1px dashed
        color-mix(in srgb, var(--color-border) 75%, transparent);
      border-radius: var(--rounded-md);
    }
    .eyebrow {
      font-size: 11px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
    }
    .disclaimer:focus-visible,
    .text-link:focus-visible {
      outline: 2px solid var(--color-primary);
      outline-offset: 2px;
    }

    /* Download server form. */
    .server {
      display: grid;
      gap: var(--spacing-xs);
    }
    .field-label {
      margin-top: var(--spacing-xs);
      font-size: 11px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--color-muted);
    }
    .input {
      min-block-size: var(--spacing-touch);
      padding: 0 var(--spacing-sm);
      font: inherit;
      color: var(--color-text);
      background: var(--color-background);
      border: 1px solid var(--color-border);
      border-radius: var(--rounded-md);
      outline: none;
      transition: border-color var(--duration-fast) var(--ease-standard);
    }
    .input::placeholder {
      color: var(--color-muted);
    }
    .input:focus,
    .input[aria-invalid='true'] {
      border-color: var(--color-primary);
    }
    .server-actions {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: var(--spacing-sm);
      margin-top: var(--spacing-sm);
    }
    /* Reserved status line so the form does not jump. */
    .status {
      margin: 0;
      min-block-size: 18px;
      font-size: 12px;
      line-height: 1.5;
    }
    .status-bad,
    .status-ok,
    .status-muted {
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .status-bad {
      color: var(--color-primary);
    }
    .status-ok {
      color: var(--color-text);
    }
    .status-muted {
      color: var(--color-muted);
    }
    .text-link {
      display: inline-flex;
      align-items: center;
      min-block-size: var(--spacing-touch);
      padding: 0;
      font: inherit;
      font-size: 13px;
      color: var(--color-text);
      text-decoration: underline;
      text-underline-offset: 3px;
      background: transparent;
      border: 0;
      border-radius: var(--rounded-md);
      cursor: pointer;
    }
    @media (prefers-reduced-motion: reduce) {
      .input {
        transition-duration: 1ms;
      }
    }
  `,
})
export class SettingsPage {
  protected readonly library = inject(LibraryStore);
  protected readonly settings = inject(SettingsStore);
  private readonly route = inject(ActivatedRoute);
  private readonly dialog = inject(OrDialog);
  private readonly toast = inject(OrToast);
  private readonly scanner = inject(PairingScannerPort, { optional: true });

  protected readonly disclaimer = MUSIC_DISCLAIMER;

  protected readonly imported = this.library.importedTracks;
  protected readonly importing = signal(false);
  protected readonly busy = signal(false);
  protected readonly editing = signal<Track | null>(null);

  // Download server form drafts; reset when the stored values change.
  protected readonly serverUrl = linkedSignal(() =>
    this.settings.downloadServerUrl(),
  );
  protected readonly serverToken = linkedSignal(() =>
    this.settings.downloadServerToken(),
  );
  protected readonly serverDirty = computed(
    () =>
      this.serverUrl().trim() !== this.settings.downloadServerUrl() ||
      this.serverToken().trim() !== this.settings.downloadServerToken(),
  );
  protected readonly savingServer = signal(false);
  /** QR scanning is offered only where the app provides a pairing scanner. */
  protected readonly canScan = signal(false);
  protected readonly scanning = signal(false);
  protected readonly serverError = signal<string | null>(null);
  protected readonly connection = this.settings.connection;
  protected readonly testing = computed(
    () => this.connection().status === 'testing',
  );
  protected readonly connectionError = computed(() => {
    const c = this.connection();
    return c.status === 'error' ? c.message : null;
  });
  private readonly disclaimerEl =
    viewChild.required<ElementRef<HTMLElement>>('disclaimerEl');

  /** Resolved cover URLs by track id (resolved at display time, never stored). */
  protected readonly art = signal<Record<string, string | undefined>>({});
  private readonly usage = signal<StorageUsage | null>(null);
  private usageRun = 0;
  private artRun = 0;

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
    // Search links here with #music-disclaimer.
    afterNextRender(() => {
      if (this.route.snapshot.fragment === 'music-disclaimer')
        this.showDisclaimer();
    });
    // Resolve cover art for imported tracks whenever the list changes.
    effect(() => {
      const tracks = this.imported();
      untracked(() => void this.resolveArt(tracks));
    });
    if (this.scanner)
      void this.scanner.available().then((ok) => this.canScan.set(ok));
    // Re-measure storage when imports change.
    effect(() => {
      this.imported();
      untracked(() => void this.refreshUsage());
    });
  }

  protected onServerInput(event: Event, field: 'url' | 'token'): void {
    const value = (event.target as HTMLInputElement).value;
    // A pasted pairing link fills in both fields and connects at once.
    if (field === 'url' && parsePairingLink(value)) {
      void this.pairWith(value);
      return;
    }
    (field === 'url' ? this.serverUrl : this.serverToken).set(value);
    this.serverError.set(null);
  }

  protected async saveServer(event?: Event): Promise<boolean> {
    event?.preventDefault();
    if (!this.serverDirty()) return true;
    this.savingServer.set(true);
    this.serverError.set(null);
    try {
      await this.settings.setDownloadServer({
        url: this.serverUrl(),
        token: this.serverToken(),
      });
      if (event)
        this.toast.show(
          this.serverUrl().trim()
            ? 'Stream server saved'
            : 'Stream server removed',
        );
      return true;
    } catch (err) {
      this.serverError.set(
        err instanceof Error && err.message.startsWith('Enter')
          ? err.message
          : 'Could not save the server. Try again.',
      );
      return false;
    } finally {
      this.savingServer.set(false);
    }
  }

  /** Pair from a pairing link, then show its outcome on the status line. */
  private async pairWith(text: string): Promise<void> {
    if (this.savingServer()) return;
    this.savingServer.set(true);
    this.serverError.set(null);
    try {
      const result = await this.settings.pairFromLink(text);
      // Show the saved values (the pasted link text is not a URL).
      this.serverUrl.set(this.settings.downloadServerUrl());
      this.serverToken.set(this.settings.downloadServerToken());
      if (result.ok) this.toast.show('Paired with your server');
      else this.serverError.set(result.message);
    } finally {
      this.savingServer.set(false);
    }
  }

  protected async scanQr(): Promise<void> {
    if (!this.scanner || this.scanning() || this.savingServer()) return;
    this.scanning.set(true);
    this.serverError.set(null);
    let text: string | null = null;
    try {
      text = await this.scanner.scan();
    } catch (err) {
      this.serverError.set(
        err instanceof Error ? err.message : 'Scanning failed. Try again.',
      );
    } finally {
      this.scanning.set(false);
    }
    if (text !== null) await this.pairWith(text);
  }

  protected async testServer(): Promise<void> {
    if (!(await this.saveServer())) return;
    await this.settings.testConnection();
  }

  protected showDisclaimer(): void {
    const el = this.disclaimerEl().nativeElement;
    el.scrollIntoView({ block: 'center' });
    el.focus({ preventScroll: true });
  }

  protected detailText(track: Track): string {
    return [track.album, track.year].filter(Boolean).join(' · ');
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

  protected async clearImported(): Promise<void> {
    const ok = await this.dialog.confirm({
      title: 'Clear imported files?',
      message:
        'Every imported record and its files will be deleted from this device, and removed from playlists and the queue.',
      confirmLabel: 'Clear imported files',
      danger: true,
    });
    if (!ok) return;
    await this.run(
      () => this.library.clearImported(),
      'Imported files cleared',
    );
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
